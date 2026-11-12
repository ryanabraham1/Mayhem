#include "../../examples/suite/competition.hpp"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
#include <string>
#include <vector>
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
  // A successful callback must not run again while a transition waits on input.
  struct LifecycleHooks final : mayhem::RobotHooks {
    int mainTicks=0,duringTicks=0,ends=0; bool allow=false;
    mayhem::ActionStatus TickAction(std::string_view id) override {
      if(id=="main") mainTicks++; else duringTicks++;
      return mayhem::ActionStatus::Succeeded;
    }
    void EndAction(std::string_view,bool) override {ends++;}
  } lifecycle;
  const std::string_view during[]={"hold"};
  const mayhem::AutoNode nodes[]={
    {"action",mayhem::NodeKind::Action,{},1,"main",{},during,1},
    {"done",mayhem::NodeKind::Finish,{},1,"",{}}
  };
  const mayhem::AutoTransition edges[]={{"exit","action","done",[](const mayhem::RobotHooks& h){return static_cast<const LifecycleHooks&>(h).allow;}}};
  mayhem::AutoRunner latched({"test","action",nodes,2,edges,1},lifecycle);
  assert(latched.Start());
  for(int i=0;i<5;i++) latched.Tick({}, {}, .02);
  assert(lifecycle.mainTicks==1&&lifecycle.duringTicks==1);
  assert(latched.Status()==mayhem::RunStatus::Running);
  lifecycle.allow=true;latched.Tick({}, {}, .02);
  assert(latched.Status()==mayhem::RunStatus::Completed&&lifecycle.ends==2);
  latched.Start();latched.Tick({}, {}, .02);
  assert(lifecycle.mainTicks==2&&lifecycle.duringTicks==2);
  // Loop overruns clamp instead of failing; the watchdog still counts real time.
  {
    mayhem::RobotHooks idle;
    const mayhem::AutoNode drive[]={{"drive",mayhem::NodeKind::Pose,{{2,0,0}},1,"",{}},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition arrive[]={{"arrive","drive","done",[](const mayhem::RobotHooks&){return true;}}};
    const mayhem::RoutineView view{"drive-test","drive",drive,2,arrive,1};
    mayhem::AutoRunner clamp(view,idle);
    assert(clamp.Start());
    const auto first=clamp.Tick({},{},.5);
    assert(clamp.Status()==mayhem::RunStatus::Running&&clamp.Overruns()==1);
    // Integrated as maxDt = 0.1 s: the 12 m/s^2 rate limit allows at most 1.2 m/s.
    assert(std::hypot(first.vx,first.vy)<=1.2+1e-9&&first.vx>0);
    // dt == 0 repeats the last command without advancing anything.
    const auto same=clamp.Tick({},{},0);
    assert(same.vx==first.vx&&clamp.StateTime()==.5&&clamp.Status()==mayhem::RunStatus::Running);
    clamp.Tick({},{},.6);  // real time 1.1 s >= 1 s watchdog
    assert(clamp.Status()==mayhem::RunStatus::Failed&&clamp.Overruns()==2);
    mayhem::RunnerOptions strict; strict.overrun=mayhem::DtOverrun::Fail;
    mayhem::AutoRunner failing(view,idle,strict);
    assert(failing.Start());failing.Tick({},{},.11);assert(failing.Status()==mayhem::RunStatus::Failed);
    mayhem::RunnerOptions loose; loose.maxDt=.25;
    mayhem::AutoRunner wide(view,idle,loose);
    assert(wide.Start());const auto big=wide.Tick({},{},.2);
    assert(wide.Overruns()==0&&std::hypot(big.vx,big.vy)>1.2+1e-9&&std::hypot(big.vx,big.vy)<=2.4+1e-9);
    for(double bad:{-.02,std::numeric_limits<double>::quiet_NaN(),std::numeric_limits<double>::infinity()}) {
      assert(clamp.Start());clamp.Tick({},{},bad);assert(clamp.Status()==mayhem::RunStatus::Failed);
    }
    mayhem::RunnerOptions invalid; invalid.maxDt=0;
    mayhem::AutoRunner broken(view,idle,invalid);
    assert(!broken.Start()&&broken.Status()==mayhem::RunStatus::Failed);
  }
  // Goal telemetry and built-in observation.
  {
    struct Recorder final : mayhem::StateObserver {
      std::string described; std::vector<std::string> guards, log;
      double lastTranslation=-1,lastRotation=-1; bool lastReached=false;
      void Describe(std::string_view json){described=std::string(json);}
      void RegisterGuard(std::string transition,std::string input){guards.push_back(transition+"|"+input);}
      void Enter(std::string_view m,std::string_view s,double t) override {log.push_back("enter "+std::string(m)+" "+std::string(s)+" "+std::to_string(int(t)));}
      void Guard(std::string_view m,std::string_view e,std::string_view i,bool b,double) override {log.push_back("guard "+std::string(m)+" "+std::string(e)+" "+std::string(i)+" "+(b?"1":"0"));}
      void Transition(std::string_view m,std::string_view e,std::string_view f,std::string_view s,double) override {log.push_back("transition "+std::string(m)+" "+std::string(e)+" "+std::string(f)+" "+std::string(s));}
      void GoalProgress(std::string_view,double x,double h,bool b,double) override {lastTranslation=x;lastRotation=h;lastReached=b;}
    } recorder;
    mayhem::RobotHooks idle;
    mayhem::Goal aimed{{2,0,0}}; aimed.headingMode=mayhem::HeadingMode::PointAt; aimed.aimX=2; aimed.aimY=5;
    const mayhem::AutoNode drive[]={{"drive",mayhem::NodeKind::Pose,aimed,5,"",{}},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition arrive[]={{"arrive","drive","done",[](const mayhem::RobotHooks&){return true;}}};
    mayhem::AutoRunner runner2({"drive-test","drive",drive,2,arrive,1},idle);
    const std::string_view parts[]={"{\"id\":","\"Autonomous\"}"};
    runner2.Attach(recorder,{parts,2},[]{return 7.0;});
    assert(recorder.described=="{\"id\":\"Autonomous\"}");
    assert(recorder.guards.size()==1&&recorder.guards[0]=="drive-test/arrive|condition");
    assert(runner2.Start()&&recorder.log.back()=="enter Autonomous drive 7");
    assert(runner2.ActiveGoal()&&runner2.ActiveGoal()->pose.x==2&&runner2.ActiveNode()->id=="drive");
    runner2.Tick({},{},.02);
    // PointAt from the origin to (2, 5): the follower's own heading target, not goal.pose.heading.
    assert(std::abs(runner2.LastResult().translationError-2)<1e-9);
    assert(std::abs(runner2.LastResult().rotationError-std::atan2(5,2))<1e-9);
    assert(recorder.lastTranslation==runner2.LastResult().translationError&&!recorder.lastReached);
    mayhem::Pose pose;mayhem::Velocity v;
    for(int i=0;i<1000&&runner2.Status()==mayhem::RunStatus::Running;i++){v=runner2.Tick(pose,v,.02);pose.x+=v.vx*.02;pose.y+=v.vy*.02;pose.heading=mayhem::Wrap(pose.heading+v.omega*.02);}
    assert(runner2.Status()==mayhem::RunStatus::Completed&&recorder.lastReached&&!runner2.ActiveGoal());
    const std::vector<std::string> tail(recorder.log.end()-3,recorder.log.end());
    assert(tail[0]=="guard Autonomous drive-test/arrive condition 1");
    assert(tail[1]=="transition Autonomous drive-test/arrive drive done");
    assert(tail[2]=="enter Autonomous done 7");
  }
  std::cout<<"Auto runner checks passed\n";
}
