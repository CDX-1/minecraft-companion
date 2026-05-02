#include <Adafruit_NeoPixel.h>
#include <math.h>

#ifndef PI
#define PI 3.14159265359f
#endif

#ifndef TWO_PI
#define TWO_PI (PI * 2.0f)
#endif

#define LED_PIN 13
#define LED_COUNT 60
#define LED_BRIGHTNESS 40
#define SERIAL_BAUD 115200

// Switch pins
#define PERSONALITY_PIN_A 32
#define PERSONALITY_PIN_B 33

#define FRAME_MS 35u

Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

/** 0 = upset … 100 = delighted */
uint8_t moodScore = 50;

enum HealthAlert {
  ALERT_NONE,
  ALERT_YELLOW,
  ALERT_RED
};

HealthAlert alert = ALERT_NONE;

String serialBuffer = "";
unsigned long lastFrameMs = 0;

// Personality switch state
int lastPersonality = -1;
unsigned long lastPersonalitySendMs = 0;

void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(PERSONALITY_PIN_A, INPUT_PULLUP);
  pinMode(PERSONALITY_PIN_B, INPUT_PULLUP);

  pixels.begin();
  pixels.setBrightness(LED_BRIGHTNESS);
  pixels.clear();
  pixels.show();

  startupColorTest();

  Serial.println(F("ESP32 mood strip ready"));
  Serial.println(F("Commands: MOOD n · GREEN · YELLOW · RED · TEST"));
  Serial.println(F("Switches send: PERSONALITY 0-3"));

  checkPersonalitySwitches(true);
}

void loop() {
  readSerialCommands();
  checkPersonalitySwitches(false);

  unsigned long now = millis();
  if (now - lastFrameMs < FRAME_MS) {
    delay(1);
    return;
  }

  lastFrameMs = now;

  switch (alert) {
    case ALERT_RED:
      drawAlertRed(now);
      break;
    case ALERT_YELLOW:
      drawAlertYellow(now);
      break;
    default:
      drawMood(now);
      break;
  }
}

void checkPersonalitySwitches(bool forceSend) {
  bool a = digitalRead(PERSONALITY_PIN_A) == LOW;
  bool b = digitalRead(PERSONALITY_PIN_B) == LOW;

  int personality = (a ? 1 : 0) + (b ? 2 : 0);

  if (
    forceSend ||
    (personality != lastPersonality && millis() - lastPersonalitySendMs > 250)
  ) {
    lastPersonality = personality;
    lastPersonalitySendMs = millis();

    Serial.print(F("PERSONALITY "));
    Serial.println(personality);
  }
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\n' || c == '\r') {
      handleCommand(serialBuffer);
      serialBuffer = "";
      continue;
    }

    if (serialBuffer.length() < 48) serialBuffer += c;
  }
}

void handleCommand(String command) {
  command.trim();

  if (command.length() == 0) return;

  String upper = command;
  upper.toUpperCase();

  if (upper.startsWith("MOOD")) {
    int idx = upper.indexOf(' ');
    int v = 50;

    if (idx >= 0) v = upper.substring(idx + 1).toInt();

    moodScore = (uint8_t)constrain(v, 0, 100);

    Serial.print(F("MOOD "));
    Serial.println((int)moodScore);
    return;
  }

  if (upper == "GREEN" || upper == "GOOD" || upper == "OK" || upper == "ALERT OFF" || upper == "OFF") {
    alert = ALERT_NONE;
    Serial.println(F("ALERT OFF"));
  } else if (upper == "YELLOW" || upper == "WARN" || upper == "WARNING") {
    alert = ALERT_YELLOW;
    Serial.println(F("ALERT YELLOW"));
  } else if (upper == "RED" || upper == "ERROR" || upper == "BAD") {
    alert = ALERT_RED;
    Serial.println(F("ALERT RED"));
  } else if (upper == "TEST") {
    startupColorTest();
    Serial.println(F("TEST"));
  } else {
    Serial.print(F("UNKNOWN "));
    Serial.println(command);
  }
}

void startupColorTest() {
  showSolidAll(255, 0, 0);
  delay(450);
  showSolidAll(0, 255, 0);
  delay(450);
  showSolidAll(0, 0, 255);
  delay(450);
  showSolidAll(255, 180, 0);
  delay(450);
  pixels.clear();
  pixels.show();
}

void showSolidAll(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < LED_COUNT; i++) {
    pixels.setPixelColor(i, pixels.Color(r, g, b));
  }

  pixels.show();
}

static float spanForStrip() {
  return (LED_COUNT > 1) ? (float)(LED_COUNT - 1) : 1.0f;
}

void moodBaseRgb(uint8_t m, float& outR, float& outG, float& outB) {
  const float t = constrain(m / 100.0f, 0.f, 1.f);
  const float H = t * 120.0f;
  const float S = 1.0f;
  const float V = 1.0f;
  const float C = V * S;
  const float Hp = H / 60.0f;
  const float X = C * (1.0f - fabsf(fmodf(Hp, 2.0f) - 1.0f));

  float r1, g1, b1;

  if (H < 60.0f) {
    r1 = C;
    g1 = X;
    b1 = 0.0f;
  } else {
    r1 = X;
    g1 = C;
    b1 = 0.0f;
  }

  const float mn = V - C;

  r1 += mn;
  g1 += mn;
  b1 += mn;

  outR = r1 * 255.0f;
  outG = g1 * 255.0f;
  outB = b1 * 255.0f;
}

void drawMood(unsigned long nowMs) {
  float tSec = nowMs / 1000.0f;

  float breathe = 0.58f + 0.42f * sinf(tSec * TWO_PI / 6.0f);

  float mr, mg, mb;
  moodBaseRgb(moodScore, mr, mg, mb);

  float span = spanForStrip();
  float slow = (tSec * TWO_PI) / 14.0f;

  for (int i = 0; i < LED_COUNT; i++) {
    float u = span > 0.001f ? (float)i / span : 0.0f;
    float veil = sinf(u * TWO_PI + slow);

    float local = constrain(breathe * (0.94f + 0.06f * veil), 0.42f, 1.0f);

    uint8_t r = (uint8_t)constrain(mr * local, 0, 255);
    uint8_t g = (uint8_t)constrain(mg * local, 0, 255);
    uint8_t b = (uint8_t)constrain(mb * local, 0, 255);

    pixels.setPixelColor(i, pixels.Color(r, g, b));
  }

  pixels.show();
}

void drawAlertYellow(unsigned long nowMs) {
  float t = nowMs / 1000.0f;

  float pulse = 0.45f + 0.55f * sinf(t * TWO_PI / 2.4f);

  uint8_t r = (uint8_t)(220 * pulse + 35);
  uint8_t gp = (uint8_t)(150 * pulse + 25);

  float span = spanForStrip();
  float drift = (t * TWO_PI) / 18.0f;

  for (int i = 0; i < LED_COUNT; i++) {
    float u = span > 0.001f ? (float)i / span : 0.0f;
    float tw = 0.92f + 0.08f * sinf(u * 3.2f * TWO_PI + drift);

    uint8_t g = (uint8_t)constrain(gp * tw, 0, 255);

    pixels.setPixelColor(
      i,
      pixels.Color(
        (uint8_t)constrain(r * tw, 48, 255),
        g,
        (uint8_t)(18 * pulse)
      )
    );
  }

  pixels.show();
}

void drawAlertRed(unsigned long nowMs) {
  float t = nowMs / 1000.0f;

  float beat = sinf(t * TWO_PI / 1.15f);
  float core = 0.52f + 0.48f * ((beat + 1.0f) * 0.5f);

  uint8_t r = (uint8_t)(90 + core * 165);
  uint8_t gbase = (uint8_t)(20 + core * 45);

  float span = spanForStrip();
  float drift = (t * TWO_PI) / 22.0f;

  for (int i = 0; i < LED_COUNT; i++) {
    float u = span > 0.001f ? (float)i / span : 0.0f;
    float tw = 0.94f + 0.06f * sinf(u * TWO_PI * 2.0f + drift);

    uint8_t g = (uint8_t)constrain(gbase * tw, 12, 80);

    pixels.setPixelColor(
      i,
      pixels.Color(
        (uint8_t)constrain((float)r * tw, 70, 255),
        g,
        (uint8_t)(core * 30)
      )
    );
  }

  pixels.show();
}