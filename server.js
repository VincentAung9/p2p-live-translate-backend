let port = process.env.PORT || 3000;

let IO = require("socket.io")(port, {
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

  socket.on("makeCall", (data) => {
    let calleeId = data.calleeId;
    let sdpOffer = data.sdpOffer;

    socket.to(calleeId).emit("newCall", {
      callerId: socket.user,
      sdpOffer: sdpOffer,
    });
  });

  socket.on("answerCall", (data) => {
    let callerId = data.callerId;
    let sdpAnswer = data.sdpAnswer;

    socket.to(callerId).emit("callAnswered", {
      callee: socket.user,
      sdpAnswer: sdpAnswer,
    });
  });

  socket.on("endCall", (data) => {
    let calleeId = data.calleeId; // the other user in the call
    console.log(socket.user, "EndCallFrom");
    console.log(calleeId, "EndCallTo");
    socket.to(calleeId).emit("callEnded", {
      from: socket.user
    });
    //emit to self
    socket.emit("leaveCall",{
        to:calleeId
    });
  });

  //for translation
  // on signaling server
    socket.on("translationText", (data) => {
    const to = data.to; // remote peer ID
    const text = data.text;
    console.log(to,text);
    if(to){
      socket.to(to).emit("incomeTranslation", {
        from: socket.user,
        text,
    });
    }else{
      socket.emit("incomeTranslation", {
        from: socket.user,
        text,
    });
    }
    });


  socket.on("IceCandidate", (data) => {
    let calleeId = data.calleeId;
    let iceCandidate = data.iceCandidate;

    socket.to(calleeId).emit("IceCandidate", {
      sender: socket.user,
      iceCandidate: iceCandidate,
    });
  });
});