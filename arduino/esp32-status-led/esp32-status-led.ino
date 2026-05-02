#include <Adafruit_NeoPixel.h>

// Wiring:
// ESP32 GND -> LED GND
// ESP32 5V/VIN -> LED 5V, or use external 5V for longer strips
// ESP32 GPIO 5 -> LED DIN
// If using external LED power, connect external GND to ESP32 GND.

#define LED_PIN 13
#define LED_COUNT 60
#define LED_BRIGHTNESS 40
#define SERIAL_BAUD 115200

// Most WS2812/NeoPixel strips are NEO_GRB.
// If startup colors look wrong, try NEO_RGB, NEO_BRG, or NEO_RGBW here.
Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

enum AiStatus {
  STATUS_GREEN,
  STATUS_YELLOW,
  STATUS_RED
};

AiStatus currentStatus = STATUS_YELLOW;
String serialBuffer = "";
unsigned long lastFrameMs = 0;
float phase = 0.0;

void setup() {
  Serial.begin(SERIAL_BAUD);
  pixels.begin();
  pixels.setBrightness(LED_BRIGHTNESS);
  pixels.clear();
  pixels.show();
  startupColorTest();
  Serial.println("ESP32 AI status LED ready");
}

void loop() {
  readSerialCommands();
  animateStatus();
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char) Serial.read();
    if (c == '\n' || c == '\r') {
      handleCommand(serialBuffer);
      serialBuffer = "";
      continue;
    }

    if (serialBuffer.length() < 32) {
      serialBuffer += c;
    }
  }
}

void handleCommand(String command) {
  command.trim();
  command.toUpperCase();

  if (command == "GREEN" || command == "GOOD" || command == "OK") {
    currentStatus = STATUS_GREEN;
    Serial.println("STATUS GREEN");
  } else if (command == "YELLOW" || command == "WARN" || command == "WARNING") {
    currentStatus = STATUS_YELLOW;
    Serial.println("STATUS YELLOW");
  } else if (command == "RED" || command == "ERROR" || command == "BAD") {
    currentStatus = STATUS_RED;
    Serial.println("STATUS RED");
  } else if (command == "TEST") {
    startupColorTest();
    Serial.println("STATUS TEST");
  }
}

void startupColorTest() {
  showSolid(255, 0, 0);
  delay(450);
  showSolid(0, 255, 0);
  delay(450);
  showSolid(0, 0, 255);
  delay(450);
  showSolid(255, 180, 0);
  delay(450);
  pixels.clear();
  pixels.show();
}

void showSolid(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(r, g, b));
  }
  pixels.show();
}

void animateStatus() {
  unsigned long now = millis();
  if (now - lastFrameMs < 20) return;
  lastFrameMs = now;

  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  float speed = 0.045;

  switch (currentStatus) {
    case STATUS_GREEN:
      r = 0;
      g = 255;
      b = 35;
      speed = 0.025;
      break;
    case STATUS_YELLOW:
      r = 255;
      g = 180;
      b = 0;
      speed = 0.045;
      break;
    case STATUS_RED:
      r = 255;
      g = 0;
      b = 0;
      speed = 0.075;
      break;
  }

  phase += speed;
  if (phase > TWO_PI) phase -= TWO_PI;

  float pulse = 0.25 + 0.75 * ((sin(phase) + 1.0) / 2.0);
  uint8_t pr = (uint8_t) (r * pulse);
  uint8_t pg = (uint8_t) (g * pulse);
  uint8_t pb = (uint8_t) (b * pulse);

  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(pr, pg, pb));
  }
  pixels.show();
}
