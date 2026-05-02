#include <Adafruit_NeoPixel.h>
#include <math.h>

#define LED_PIN 13
#define LED_COUNT 60
#define LED_BRIGHTNESS 40
#define SERIAL_BAUD 115200

#define ULTRASONIC_TRIG_PIN 5
#define ULTRASONIC_ECHO_PIN 18

#define FRAME_MS 35

Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

uint8_t moodScore = 50;

enum HealthAlert {
  ALERT_NONE,
  ALERT_YELLOW,
  ALERT_RED
};

HealthAlert alert = ALERT_NONE;

String serialBuffer = "";
unsigned long lastFrameMs = 0;

/* ================= SETUP ================= */

void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(ULTRASONIC_TRIG_PIN, OUTPUT);
  pinMode(ULTRASONIC_ECHO_PIN, INPUT);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);

  pixels.begin();
  pixels.setBrightness(LED_BRIGHTNESS);
  pixels.clear();
  pixels.show();

  Serial.println("ESP32 READY");
}

/* ================= LOOP ================= */

void loop() {
  readSerialCommands();
  readUltrasonicSensor();

  unsigned long now = millis();
  if (now - lastFrameMs < FRAME_MS) return;
  lastFrameMs = now;

  if (alert == ALERT_RED) drawRed();
  else if (alert == ALERT_YELLOW) drawYellow();
  else drawMood();
}

/* ================= ULTRASONIC + WAVE ================= */

void readUltrasonicSensor() {
  static unsigned long lastRead = 0;
  static int state = 0;
  static unsigned long stateTime = 0;

  if (millis() - lastRead < 60) return;
  lastRead = millis();

  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);

  long duration = pulseIn(ULTRASONIC_ECHO_PIN, HIGH, 30000);
  if (duration == 0) return;

  float distance = duration * 0.0343 / 2.0;

  Serial.print("DIST ");
  Serial.println(distance);

  bool close = distance < 15;

  switch (state) {
    case 0:
      if (close) {
        state = 1;
        stateTime = millis();
      }
      break;

    case 1:
      if (!close && millis() - stateTime < 600) {
        state = 2;
        stateTime = millis();
      }
      break;

    case 2:
      if (close && millis() - stateTime < 600) {
        Serial.println("WAVE");

        moodScore = 90; // react to wave
        flashWhite();

        state = 0;
      }
      break;
  }
}

/* ================= SERIAL ================= */

void readSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n' || c == '\r') {
      handleCommand(serialBuffer);
      serialBuffer = "";
    } else {
      serialBuffer += c;
    }
  }
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();

  if (cmd.startsWith("MOOD")) {
    int v = cmd.substring(5).toInt();
    moodScore = constrain(v, 0, 100);
  }

  if (cmd == "RED") alert = ALERT_RED;
  if (cmd == "YELLOW") alert = ALERT_YELLOW;
  if (cmd == "GREEN") alert = ALERT_NONE;
}

/* ================= LED ================= */

void drawMood() {
  float t = millis() / 1000.0;
  float breathe = 0.6 + 0.4 * sin(t);

  float r = (100 - moodScore) * 2.55;
  float g = moodScore * 2.55;

  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(r * breathe, g * breathe, 0));
  }
  pixels.show();
}

void drawYellow() {
  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(255, 180, 0));
  }
  pixels.show();
}

void drawRed() {
  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(255, 0, 0));
  }
  pixels.show();
}

void flashWhite() {
  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(255, 255, 255));
  }
  pixels.show();
  delay(100);
}