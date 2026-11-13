// Mayhem review probe. Mayhem copies this file into a temporary checkout of the robot repo
// (src/test/cpp/MayhemReviewProbe.cpp) to run scripted scenarios through the robot's own
// RobotHarness; it is never committed to the robot code.
//
// One scenario per process: MAYHEM_SCENARIO names a JSON file
//   { "alliance": "blue" | "red", "field": bool, "steps": [ ... ] }
// with steps run in order:
//   { "kind": "mode", "mode": "disabled" | "teleop" | "auto" }
//   { "kind": "auto", "name": "<chooser name>" }
//   { "kind": "button", "button": "A"|"B"|"X"|"Y"|"LB"|"RB"|"LT"|"RT"|"Back"|"Start"|"LS"|"RS"|
//                                 "Up"|"Down"|"Left"|"Right", "down": bool }
//   { "kind": "axis", "axis": "leftX"|"leftY"|"rightX"|"rightY", "value": -1..1 }
//   { "kind": "wait", "seconds": s }
// The robot logs to ROBOT_LOG_DIR as usual; MAYHEM_RESULT receives a JSON summary of the
// simulated field (hits, tipping, battery) when the robot has a physics world.
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <string>

#include <gtest/gtest.h>
#include <wpi/json.h>

#include "RobotHarness.h"
#if __has_include("sim/PhysicsWorld.h")
#include "sim/PhysicsWorld.h"
#define MAYHEM_PROBE_PHYSICS 1
#endif

namespace {
using XSim = frc::sim::XboxControllerSim;

void SetButton(XSim& c, const std::string& b, bool down) {
  if (b == "A") c.SetAButton(down);
  else if (b == "B") c.SetBButton(down);
  else if (b == "X") c.SetXButton(down);
  else if (b == "Y") c.SetYButton(down);
  else if (b == "LB") c.SetLeftBumperButton(down);
  else if (b == "RB") c.SetRightBumperButton(down);
  else if (b == "Back") c.SetBackButton(down);
  else if (b == "Start") c.SetStartButton(down);
  else if (b == "LS") c.SetLeftStickButton(down);
  else if (b == "RS") c.SetRightStickButton(down);
  else if (b == "LT") c.SetLeftTriggerAxis(down ? 1.0 : 0.0);
  else if (b == "RT") c.SetRightTriggerAxis(down ? 1.0 : 0.0);
  else if (b == "Up") c.SetPOV(down ? 0 : -1);
  else if (b == "Right") c.SetPOV(down ? 90 : -1);
  else if (b == "Down") c.SetPOV(down ? 180 : -1);
  else if (b == "Left") c.SetPOV(down ? 270 : -1);
  else FAIL() << "Unknown button " << b;
}

void SetAxis(XSim& c, const std::string& axis, double value) {
  if (axis == "leftX") c.SetLeftX(value);
  else if (axis == "leftY") c.SetLeftY(value);
  else if (axis == "rightX") c.SetRightX(value);
  else if (axis == "rightY") c.SetRightY(value);
  else FAIL() << "Unknown axis " << axis;
}
}  // namespace

TEST(MayhemReviewProbe, Scenario) {
  const char* path = std::getenv("MAYHEM_SCENARIO");
  if (path == nullptr) {
    GTEST_SKIP() << "Run by Mayhem with MAYHEM_SCENARIO set.";
  }
  std::ifstream in{path};
  const wpi::json scenario = wpi::json::parse(in);
  RobotHarness h{scenario.value("alliance", std::string{"blue"}) == "red", scenario.value("field", false)};
  double t = 0;
  for (const auto& step : scenario.at("steps")) {
    const std::string kind = step.at("kind");
    if (kind == "wait") {
      const int loops = static_cast<int>(std::lround(step.at("seconds").get<double>() / 0.02));
      h.Step(loops);
      t += loops * 0.02;
    } else if (kind == "mode") {
      const std::string mode = step.at("mode");
      if (mode == "teleop") h.Teleop();
      else if (mode == "auto") h.Autonomous();
      else h.Disable();
    } else if (kind == "auto") {
      h.C().GetAutoChooser().Select(step.at("name").get<std::string>());
    } else if (kind == "button") {
      SetButton(h.Driver(), step.at("button"), step.at("down"));
    } else if (kind == "axis") {
      SetAxis(h.Driver(), step.at("axis"), step.at("value"));
    } else {
      FAIL() << "Unknown step " << kind;
    }
  }
  wpi::json result = {{"seconds", t}};
#ifdef MAYHEM_PROBE_PHYSICS
  const auto& m = sim::PhysicsWorld::Get().GetMetrics();
  const auto pose = sim::PhysicsWorld::Get().TruePose();
  result["physics"] = {{"tippedOver", m.tippedOver},     {"brownedOut", m.brownedOut},
                       {"hits", m.hits},                 {"wallHits", m.wallHits},
                       {"obstacleHits", m.obstacleHits}, {"beachedSeconds", m.beachedSeconds},
                       {"minBatteryVolts", m.minBatteryVolts},
                       {"maxTotalCurrent", m.maxTotalCurrent},
                       {"shotsFired", m.shotsFired},     {"intaked", m.intaked},
                       {"scoredOwnHub", m.scoredOwnHub},
                       {"end", {pose.X().value(), pose.Y().value(), pose.Rotation().Radians().value()}}};
#endif
  h.Disable();
  h.Step(2);
  if (const char* out = std::getenv("MAYHEM_RESULT")) {
    std::ofstream{out} << result.dump(2);
  }
}
