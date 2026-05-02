# ESP32 AI Status LED

Arduino sketch for Minecraft Companion status lights.

## Hardware

- ESP32
- WS2812/NeoPixel LED strip/ring
- Default data pin: GPIO 5
- Default LED count: 8
- Baud rate: 115200

## Wiring

- ESP32 `GND` -> LED `GND`
- ESP32 `5V`/`VIN` -> LED `5V`, or use external 5V for larger strips
- ESP32 `GPIO 5` -> LED `DIN`
- If using external LED power, connect external power `GND` to ESP32 `GND`

## Arduino IDE Setup

Install this library:

- `Adafruit NeoPixel`

Then open `esp32-status-led.ino`, adjust `LED_PIN` and `LED_COUNT` if needed, and upload to the ESP32.

## Companion .env

Set the ESP32 serial port:

```env
LED_SERIAL_PORT=/dev/cu.usbserial-0001
LED_SERIAL_BAUD=115200
```

On macOS, find the port with:

```bash
ls /dev/cu.*
```

The Companion sends:

- `GREEN` when online and healthy
- `YELLOW` for warnings/degraded state
- `RED` for errors/disconnect/low health
