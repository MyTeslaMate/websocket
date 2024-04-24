const WebSocket = require('ws');
const { PubSub } = require('@google-cloud/pubsub');

// Création du serveur WebSocket
const wss = new WebSocket.Server({ port: 8081 });

// Spécifiez le chemin vers votre fichier key.json
const credentials = process.env.CREDENTIALS;
const projectId = 'telemetry-420222';
const subscriptionName = 'subTest';

// Créez une instance Pub/Sub en utilisant le fichier key.json
const pubsub = new PubSub({ projectId, credentials });

let tags = {};
// Fonction pour envoyer un message à tous les clients WebSocket connectés
function broadcastMessage(message) {
  try {
    const jsonData = JSON.parse(message);
    const associativeArray = {};
  
    // Itérer sur les données pour extraire les clés et les valeurs
    jsonData.data.forEach(item => {
      // Vérifier si la valeur est un objet locationValue
      if (item.value.locationValue) {
          // Si oui, enregistrer l'objet locationValue directement
          associativeArray['Latitude'] = item.value.locationValue.latitude;
          associativeArray['Longitude'] = item.value.locationValue.longitude;
      } else {
          // Sinon, enregistrer la valeur stringValue
          associativeArray[item.key] = item.value.stringValue;
      }
    });
  
    const r = {
      msg_type: "data:update", 
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(), //Date.now(), // time
        associativeArray['VehicleSpeed'] ?? 0, // speed 
        associativeArray['Odometer'], // odometer 
        associativeArray['Soc'], // soc
        0,  // elevation ?
        associativeArray['GpsHeading'] || 0, // est_heading ?
        associativeArray['Latitude'], // est_lat
        associativeArray['Longitude'], // est_lng
        (associativeArray['ACChargingPower'] != '0' || associativeArray['DCChargingPower'] != '0') ? 1 : 0, // power 
        associativeArray['Gear'] ?? 0, // 0 shift_state 
        associativeArray['RatedRange'], // range 
        associativeArray['EstBatteryRange'], // est_range
        associativeArray['GpsHeading'] || 0 // heading
      ].join(',')
    };
    console.log(r);
  
    wss.clients.forEach(function each(client) {
      if (tags[r.tag] && client == tags[r.tag] && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(r));
      }
    });
  } catch (e) {
    console.error(e);
  }
}

// Écoute des connexions entrantes
wss.on('connection', function connection(ws, req) {
  console.log('Nouvelle connexion établie.');

  // Écouter le message contenant le nom du client
  ws.on('open', function incoming(open) {
    console.log('Open : %s', message);
  });

  // Écouter le message contenant le nom du client
  ws.on('message', function incoming(message) {
    console.log('Data : %s', message);
    const js = JSON.parse(message);
    if(js.msg_type == 'data:subscribe_oauth') {
      tags[js.tag] = ws;
    }
    ws.send(JSON.stringify({
      msg_type: "control:hello", 
      connection_timeout: 30000
    }));
  });

  // Gérer la fermeture de la connexion
  ws.on('close', function close() {
    console.log('Connexion fermée.');
    let keys = Object.keys(tags);
    for (i = 0; i < keys.length; i++) {
      if (this == tags[keys[i]]) {
        delete tags[keys[i]];
      }
    }
  });
});

// Écouter les messages Pub/Sub
pubsub
  .subscription(subscriptionName)
  .on('message', (message) => {
    // Envoyer le message reçu à tous les clients WebSocket connectés
    broadcastMessage(message.data.toString('utf-8'));
    message.ack();
  });