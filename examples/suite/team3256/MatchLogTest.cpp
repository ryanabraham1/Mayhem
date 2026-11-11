// Scratch harness for Mayhem: runs a practice match (auto + teleop) in the full-robot simulation
// with WPILib data logging on. Run one test per process with ROBOT_LOG_DIR set to get one .wpilog
// per match. Not part of the team repository.

#include <gtest/gtest.h>

#include "RobotHarness.h"

namespace {
using XSim = frc::sim::XboxControllerSim;

void Hold(RobotHarness& h, double seconds) { h.Step(static_cast<int>(seconds / 0.02)); }

void Drive(RobotHarness& h, double forward, double left, double seconds) {
  h.Driver().SetLeftY(-forward);
  h.Driver().SetLeftX(-left);
  Hold(h, seconds);
  h.Driver().SetLeftY(0);
  h.Driver().SetLeftX(0);
}

void PracticeMatch(const char* autoName) {
  RobotHarness h{false};
  Hold(h, 1.0);
  h.C().GetAutoChooser().Select(autoName);
  Hold(h, 0.5);
  h.Autonomous();
  Hold(h, 15.0);
  h.Disable();
  Hold(h, 1.0);
  h.Teleop();
  Hold(h, 0.5);
  // Leave the alliance zone and intake across the neutral zone.
  h.Tap([](XSim& c, bool v) { c.SetXButton(v); });
  Drive(h, 1.0, 0.0, 2.2);
  Drive(h, 0.0, 0.6, 1.2);
  Drive(h, 0.5, -0.6, 1.5);
  // Come home into the zone (revs), then shoot while still intaking.
  Drive(h, -1.0, 0.0, 2.6);
  Hold(h, 0.6);
  h.Tap([](XSim& c, bool v) { c.SetAButton(v); });
  Hold(h, 3.5);
  // A jam: jitter, then shoot again.
  h.Tap([](XSim& c, bool v) { c.SetYButton(v); });
  Hold(h, 1.5);
  h.Tap([](XSim& c, bool v) { c.SetAButton(v); });
  Hold(h, 2.5);
  // Second cycle with a hard sprint, then outtake and home.
  h.Tap([](XSim& c, bool v) { c.SetXButton(v); });
  Drive(h, 1.0, 0.3, 2.4);
  Drive(h, -1.0, -0.3, 2.4);
  h.Tap([](XSim& c, bool v) { c.SetAButton(v); });
  Hold(h, 3.0);
  h.Driver().SetLeftTriggerAxis(1.0);
  Hold(h, 0.8);
  h.Driver().SetLeftTriggerAxis(0.0);
  h.Tap([](XSim& c, bool v) { c.SetBButton(v); });
  Hold(h, 1.5);
  h.Disable();
  Hold(h, 0.5);
}
}  // namespace

TEST(MatchLog, DepotTrenchSweepDepot) { PracticeMatch("Depot Trench Sweep Depot"); }
TEST(MatchLog, OutpostTrenchSweep) { PracticeMatch("Outpost Trench Sweep"); }
TEST(MatchLog, OutpostTrenchSweepX2) { PracticeMatch("Outpost Trench Sweep x2"); }
TEST(MatchLog, DepotTrenchSweep) { PracticeMatch("Depot Trench Sweep"); }
TEST(MatchLog, DepotTrenchSweepX2) { PracticeMatch("Depot Trench Sweep x2"); }
