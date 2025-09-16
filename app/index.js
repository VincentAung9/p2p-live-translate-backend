const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const speech = require("@google-cloud/speech");
const { Translate } = require("@google-cloud/translate").v2;
const translate = new Translate(); // for translation
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

  // --- Speech-to-Text + Translation ---
  let recognizeStream = null;

  socket.on("startSTT", (data) => {
    console.log("Starting STT for", socket.user, "lang:", data.language);

    recognizeStream = client
      .streamingRecognize({
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: data.language || "en-US", // choose "en-US" or "my-MM"
        },
        interimResults: true,
      })
      .on("error", (err) => console.error("STT error:", err))
      .on("data", async (sttData) => {
        console.log(sttData,"STTData");
        const transcription =
          sttData.results[0]?.alternatives[0]?.transcript || "";
        if (transcription) {
          console.log(`Transcription [${socket.user}]: ${transcription}`);

          // Auto-detect translation target
          let targetLang = data.language === "en-US" ? "my" : "en";
          let [translatedText] = await translate.translate(
            transcription,
            targetLang
          );
          console.log(translatedText,"Translated-text");
          // Send both original + translated back
          socket.to(data.to).emit("sttResult", {
            text: transcription,
            translated: translatedText,
            from: data.language,
            to: targetLang,
          });
          socket.emit("sttResult", {
            text: transcription,
            translated: translatedText,
            from: data.language,
            to: targetLang,
          });
        }
      });
  });

  socket.on("audioChunk", (chunk) => {
    if (recognizeStream) {
      recognizeStream.write(chunk);
    }
  });

  socket.on("stopSTT", () => {
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      console.log("Stopped STT for", socket.user);
    }
  });


  socket.on("disconnect", () => {
    console.log(socket.user, "Disconnected");
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      console.log("Stopped STT for", socket.user);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO STT server running on port ${PORT}`);
});
