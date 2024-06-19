# Streaming Telemetry Events

This application deploys on the same port:

- A web server to receive Tesla Telemetry events
- A WebSocket server to forward Telemetry events to connected clients

It replaces the "Owner" streaming for your Teslamate instance.

## Usage

A TeslaMate instance can use this WSS as a streaming source.

## Limitations

- [Live power is not available](https://github.com/teslamotors/fleet-telemetry/issues/170): Wait for the Telemetry team. The power value is 0.
- Live elevation is not available
