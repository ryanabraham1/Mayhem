#include "../../examples/suite/competition.hpp"
#include <cassert>
#include <iostream>
#include <limits>
struct Hooks final : mayhem::RobotHooks {
  bool hasPiece=true; int starts=0,ends=0;
  mayhem::SignalValue Signal(std::string_view key) const override {
    if(key=="pieceDetected") return hasPiece;
    if(key=="shooterReady"||key=="shotComplete") return true;
    return {};
  }
  void BeginAction(std::string_view) override {starts++;}
  mayhem::ActionStatus TickAction(std::string_view action) override {return action=="intake.acquire"&&!hasPiece?mayhem::ActionStatus::Running:mayhem::ActionStatus::Succeeded;}
  void EndAction(std::string_view,bool) override {ends++;}
};
int main() {
  Hooks hooks;
  mayhem::AutoRunner runner(mayhem_generated::routine_0::routine,hooks);
  assert(runner.Start());
  mayhem::Pose pose=mayhem_generated::startPose;mayhem::Velocity velocity;
  for(int i=0;i<1500&&runner.Status()==mayhem::RunStatus::Running;i++) {velocity=runner.Tick(pose,velocity,.02);pose.x+=velocity.vx*.02;pose.y+=velocity.vy*.02;pose.heading=mayhem::Wrap(pose.heading+velocity.omega*.02);}
  assert(runner.Status()==mayhem::RunStatus::Completed);assert(hooks.starts==2&&hooks.ends==2);
  runner.Start();for(int i=0;i<500&&runner.Status()==mayhem::RunStatus::Running;i++)runner.Tick({1.4,4,0},{},.02);
  assert(runner.Status()==mayhem::RunStatus::Failed);assert(runner.ActiveState()=="pickup");
  // Unknown inputs fail closed even through NOT.
  assert(!mayhem::Not(mayhem::Compare({},mayhem::CompareOp::Eq,true)).value_or(false));
  assert(!mayhem::Not(mayhem::Compare(std::numeric_limits<double>::quiet_NaN(),mayhem::CompareOp::Gt,1.0)).value_or(false));
  const auto red=mayhem::FlipPose({1,2,0},16,8);assert(red.x==15&&red.y==6);
  std::cout<<"Auto runner checks passed\n";
}
