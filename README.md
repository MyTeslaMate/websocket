# Websocket server to reproduce old streaming API with new Tesla Telemetry events

Create an express server with : 
- a route used in a GCP Pub/Sub to receive Telemtry event
- a websocket server listening on /streaming

## TeslaMate usage

Teslamate can use this websocket server as streaming source.
