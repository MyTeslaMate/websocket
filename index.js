const WebSocket = require("ws");
const { PubSub } = require("@google-cloud/pubsub");

// New WebSocket Server
const wss = new WebSocket.Server({ port: 8081 });

const credentials = JSON.parse(process.env.CREDENTIALS);
const projectId = process.env.PROJECT_ID;
const subscriptionName = process.env.SUBSCRIPTION_NAME;

// Pub/Sub instance using key.json
const pubsub = new PubSub({ projectId, credentials });

let tags = {};

function broadcastMessage(message) {
  try {
    const jsonData = JSON.parse(message);
    const associativeArray = {};

    // Extract data from streaminf
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

    wss.clients.forEach(function each(client) {
      if (
        tags[r.tag] &&
        client == tags[r.tag] &&
        client.readyState === WebSocket.OPEN
      ) {
        client.send(JSON.stringify(r));
      }
    });
  } catch (e) {
    console.error(e);
  }
}

wss.on("connection", function connection(ws /*, req*/) {
  /*ws.on('open', function incoming(open) {
    //console.log('Open : %s', message);
  });*/

  const interval_id = setInterval(function () {
    ws.send(
      JSON.stringify({
        msg_type: "control:hello",
        connection_timeout: 10000,
      }),
    );
  }, 10000);

  ws.on("message", function incoming(message) {
    console.log("Data : %s", message);
    const js = JSON.parse(message);
    if (js.msg_type == "data:subscribe_oauth") {
      tags[js.tag] = ws;
    }
  });

  ws.once("close", function close() {
    clearInterval(interval_id);
    let keys = Object.keys(tags);
    for (let i = 0; i < keys.length; i++) {
      if (this == tags[keys[i]]) {
        delete tags[keys[i]];
      }
    }
  });
});

// Listen Pub/Sub message
pubsub.subscription(subscriptionName).on("message", (message) => {
  // Send received message to connected and eligible websocket client
  broadcastMessage(message.data.toString("utf-8"));
  message.ack();
});
