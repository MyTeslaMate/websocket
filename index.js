//var path = require('path');
var express = require("express");
const { WebSocket } = require("ws");
var app = express();
require("express-ws")(app);
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/", (req, res) => {
  let data = req.body.message.data;
  let buff = new Buffer.from(data, "base64");
  let message = buff.toString("ascii");

  broadcastMessage(message);
  res.status(200).json({ status: "ok" });
});

// Save ws associated with each tag
let tags = {};

app.ws("/streaming/", (ws /*, req*/) => {
  console.log("New connection");

  const interval_id = setInterval(function () {
    ws.send(
      JSON.stringify({
        msg_type: "control:hello",
        connection_timeout: 30000,
      }),
    );
  }, 10000);

  ws.on("message", function incoming(message) {
    console.log("Get message: %s", message);

    const js = JSON.parse(message);
    if (js.msg_type == "data:subscribe_oauth") {
      tags[js.tag] = ws;

      ws.send(
        JSON.stringify({
          msg_type: "control:hello",
          connection_timeout: 30000,
        }),
      );
    }
  });

  ws.once("close", function close() {
    console.log("Close connection");
    clearInterval(interval_id);
    let keys = Object.keys(tags);
    for (let i = 0; i < keys.length; i++) {
      if (this == tags[keys[i]]) {
        delete tags[keys[i]];
      }
    }
  });
});

function broadcastMessage(message) {
  try {
    const jsonData = JSON.parse(message);
    const associativeArray = {};

    // Extract data from JSON event
    jsonData.data.forEach((item) => {
      // Check if this is a location
      if (item.value.locationValue) {
        associativeArray["Latitude"] = item.value.locationValue.latitude;
        associativeArray["Longitude"] = item.value.locationValue.longitude;
      } else {
        // Else, save stringValue
        associativeArray[item.key] = item.value.stringValue;
      }
    });

    const r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(), //Date.now(), // time
        associativeArray["VehicleSpeed"] ?? 0, // speed
        associativeArray["Odometer"], // odometer
        associativeArray["Soc"], // soc
        0, // elevation ?
        associativeArray["GpsHeading"] || 0, // est_heading ?
        associativeArray["Latitude"], // est_lat
        associativeArray["Longitude"], // est_lng
        associativeArray["ACChargingPower"] != "0" ||
        associativeArray["DCChargingPower"] != "0"
          ? 1
          : 0, // power
        associativeArray["Gear"] ?? 0, // 0 shift_state
        associativeArray["RatedRange"], // range
        associativeArray["EstBatteryRange"], // est_range
        associativeArray["GpsHeading"] || 0, // heading
      ].join(","),
    };
    console.log(r);
    if (
      jsonData.vin in tags &&
      tags[jsonData.vin].readyState === WebSocket.OPEN
    ) {
      tags[r.tag].send(JSON.stringify(r));
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
