const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const speech = require("@google-cloud/speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;
const translationClient = new TranslationServiceClient(); // V3 client

// If running locally with .env
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

// If running in Railway with BASE64 encoded key
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
  const keyPath = "/tmp/speech-key.json";
  fs.writeFileSync(
    keyPath,
    Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, "base64")
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}
console.log("Temp key path:", process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64);
console.log("File exists?", fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64));

const client = new speech.SpeechClient(); // for STT
const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID; 
const location = "global"; // V3 translation client location

const IO = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

IO.use((socket, next) => {
  if (socket.handshake.query) {
    let callerId = socket.handshake.query.callerId;
    socket.user = callerId;
    next();
  }
});

IO.on("connection", (socket) => {
  console.log(socket.user, "Connected");
  socket.join(socket.user);

  // --- Call signaling ---
  socket.on("makeCall", (data) => {
    let calleeId = data.calleeId;
    let sdpOffer = data.sdpOffer;
    console.log(`Make Call: to${calleeId} from:${socket.user}`);
    socket.to(calleeId).emit("newCall", {
      callerId: socket.user,
      sdpOffer,
    });
  });

  socket.on("answerCall", (data) => {
    let callerId = data.callerId;
    let sdpAnswer = data.sdpAnswer;
    socket.to(callerId).emit("callAnswered", {
      callee: socket.user,
      sdpAnswer,
    });
  });

  socket.on("endCall", (data) => {
    let calleeId = data.calleeId;
    console.log(socket.user, "EndCallFrom", calleeId);
    socket.to(calleeId).emit("callEnded", { from: socket.user });
    socket.emit("leaveCall", { to: calleeId });
  });

  socket.on("IceCandidate", (data) => {
    let calleeId = data.calleeId;
    let iceCandidate = data.iceCandidate;
    socket.to(calleeId).emit("IceCandidate", {
      sender: socket.user,
      iceCandidate,
    });
  });

  socket.on("audioRecording", async (data) => {
    console.log(`Received audio recording from ${socket.user} for language ${data.language}`);

    const audioBytes = data.audio;

    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: data.language || "en-US",
      },
      audio: {
        content: Buffer.from(data.audio).toString("base64"),
      },
    };

    try {
      // 1. Use the non-streaming recognize method
      const [response] = await client.recognize(request);
      console.log(`Response [${JSON.stringify(response)}]`);
      const transcription = response.results
        .map((result) => result.alternatives[0].transcript)
        .join("\n");

      console.log(`Transcription [${socket.user}]: ${transcription}`);

      if (transcription) {
        // 2. Translate the final transcription using V3
        const targetLang = data.language === "en-US" ? "my" : "en";
        const translateRequest = {
          parent: `projects/${projectId}/locations/${location}`,
          contents: [transcription],
          mimeType: "text/plain",
          sourceLanguageCode: data.language,
          targetLanguageCode: targetLang,
        };
        
        const [translationResponse] = await translationClient.translateText(translateRequest);
        const translatedText = translationResponse.translations[0].translatedText;

        console.log(`Translated [${socket.user}]: ${translatedText}`);

        // 3. Send the final result back to the client(s)
        const resultPayload = {
          text: transcription,
          translated: translatedText,
          from: socket.user,
          to: data.to,
        };

        // Send to the other user
        socket.to(data.to).emit("sttResult", resultPayload);
      }
    } catch (err) {
      console.error("Google Speech-to-Text Error:", err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO STT server running on port ${PORT}`);
});