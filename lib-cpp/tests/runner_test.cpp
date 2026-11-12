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
    mayhem::Pose at;mayhem::Velocity v;
    for(int i=0;i<1000&&runner2.Status()==mayhem::RunStatus::Running;i++){v=runner2.Tick(at,v,.02);at.x+=v.vx*.02;at.y+=v.vy*.02;at.heading=mayhem::Wrap(at.heading+v.omega*.02);}
    assert(runner2.Status()==mayhem::RunStatus::Completed&&recorder.lastReached&&!runner2.ActiveGoal());
    const std::vector<std::string> tail(recorder.log.end()-3,recorder.log.end());
    assert(tail[0]=="guard Autonomous drive-test/arrive condition 1");
    assert(tail[1]=="transition Autonomous drive-test/arrive drive done");
    assert(tail[2]=="enter Autonomous done 7");
  }
  // Motion heading faces travel through a pickup; headingOffset pi drives backward;
  // anticipateSpeedCaps reaches a slower step's handoff at its cap.
  {
    struct Pickup final : mayhem::RobotHooks {
      double headingAtEvent=NAN, travelAtEvent=NAN; mayhem::Pose pose; mayhem::Velocity v;
      void PathEvent(std::string_view) override {headingAtEvent=pose.heading;travelAtEvent=std::atan2(v.vy,v.vx);}
    };
    const mayhem::PathMarker intake[]={{mayhem::MarkerKind::Event,.6,0,"intake",true}};
    auto drive=[&](double offset,bool anticipate,double cap,double& entry) {
      mayhem::Goal a{{4,1,0}}; a.headingMode=mayhem::HeadingMode::Free;
      mayhem::Goal b{{7,1,0}}; b.headingMode=mayhem::HeadingMode::Motion; b.headingOffset=offset; b.markers=intake; b.markerCount=1;
      mayhem::Goal c{{7,4,3.14159265358979323846}};
      mayhem::Constraints fast; fast.anticipateSpeedCaps=anticipate;
      mayhem::Constraints slow=fast; slow.maxVelocity=cap;
      const mayhem::AutoNode nodes[]={{"a",mayhem::NodeKind::Pose,a,15,"",fast,nullptr,0,1,true},{"b",mayhem::NodeKind::Pose,b,15,"",slow,nullptr,0,2,true},
        {"c",mayhem::NodeKind::Pose,c,15,"",fast},{"f",mayhem::NodeKind::Finish,{},1,"",{}}};
      const mayhem::AutoTransition edges[]={{"1","a","b",[](const mayhem::RobotHooks&){return true;}},{"2","b","c",[](const mayhem::RobotHooks&){return true;}},{"3","c","f",[](const mayhem::RobotHooks&){return true;}}};
      Pickup hooks; mayhem::AutoRunner r({"p","a",nodes,4,edges,3},hooks); hooks.pose={1,1,1.5707963267948966}; r.Start();
      entry=-1;
      for(int i=0;i<3000&&r.Status()==mayhem::RunStatus::Running;i++){
        hooks.v=r.Tick(hooks.pose,hooks.v,.02);
        if(entry<0&&r.ActiveState()=="b") entry=std::hypot(hooks.v.vx,hooks.v.vy);
        hooks.pose.x+=hooks.v.vx*.02;hooks.pose.y+=hooks.v.vy*.02;hooks.pose.heading=mayhem::Wrap(hooks.pose.heading+hooks.v.omega*.02);
      }
      assert(r.Status()==mayhem::RunStatus::Completed);
      return std::abs(mayhem::Wrap(hooks.headingAtEvent-hooks.travelAtEvent-offset));
    };
    double entry=0;
    assert(drive(0,false,4.5,entry)<10*3.14159265358979323846/180);
    assert(drive(3.14159265358979323846,false,4.5,entry)<10*3.14159265358979323846/180);
    drive(0,false,1,entry); assert(entry>2);
    drive(0,true,1,entry); assert(entry<=1.05);
  }
  std::cout<<"Auto runner checks passed\n";
}
