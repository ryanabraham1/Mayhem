#include "../../examples/suite/competition.hpp"
#include <algorithm>
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
  // Action binding without RobotHooks: Bind/Instant/BindSignal, and the startup check.
  {
    mayhem::AutoRunner bound(mayhem_generated::routine_0::routine);
    assert(bound.UnboundReport()=="action intake.acquire (node collect)\naction shooter.fire (node shoot)\n"
                                  "signal pieceDetected\nsignal shooterReady\nsignal shotComplete\n");
    int acquires=0,fires=0,fireTicks=0,ends=0; bool cancelledEnd=true, piece=false;
    bound.Bind("intake.acquire",mayhem::Instant([&]{acquires++;}))
         .Bind("shooter.fire",{[&]{fires++;},[&]{return ++fireTicks>=3?mayhem::ActionStatus::Succeeded:mayhem::ActionStatus::Running;},
                               [&](bool cancelled){ends++;cancelledEnd=cancelled;}})
         .BindSignal("pieceDetected",[&]{return mayhem::SignalValue{piece};})
         .BindSignal("shooterReady",[]{return mayhem::SignalValue{true};});
    const auto missing=bound.Unbound();
    assert(missing.size()==1&&missing[0].kind=="signal"&&missing[0].id=="shotComplete"&&missing[0].node.empty());
    bound.BindSignal("shotComplete",[&]{return mayhem::SignalValue{fireTicks>=3};});
    assert(bound.Unbound().empty()&&bound.UnboundReport().empty());
    static double now=0;
    bound.SetClock([]{return now;});
    assert(bound.Start());
    mayhem::Pose pose=mayhem_generated::startPose;mayhem::Velocity velocity;
    for(int i=0;i<1500&&bound.Status()==mayhem::RunStatus::Running;i++) {
      now+=.02;
      if(bound.ActiveState()=="collect"&&i%20==0) piece=true;
      velocity=bound.Tick(pose,velocity);  // dt from the clock
      pose.x+=velocity.vx*.02;pose.y+=velocity.vy*.02;pose.heading=mayhem::Wrap(pose.heading+velocity.omega*.02);
    }
    assert(bound.Status()==mayhem::RunStatus::Completed&&acquires==1&&fires==1&&fireTicks==3&&ends==1&&!cancelledEnd);
    // Without a clock the clocked tick fails instead of stalling.
    mayhem::AutoRunner unclocked(mayhem_generated::routine_0::routine);
    assert(unclocked.Start());unclocked.Tick(pose,{});assert(unclocked.Status()==mayhem::RunStatus::Failed);
    // An unbound action fails its step (and Unbound() said so at startup).
    mayhem::AutoRunner partial(mayhem_generated::routine_0::routine);
    partial.BindSignal("pieceDetected",[]{return mayhem::SignalValue{true};});
    assert(partial.Start());
    pose=mayhem_generated::startPose;velocity={};
    for(int i=0;i<1500&&partial.Status()==mayhem::RunStatus::Running;i++) {
      velocity=partial.Tick(pose,velocity,.02);
      pose.x+=velocity.vx*.02;pose.y+=velocity.vy*.02;pose.heading=mayhem::Wrap(pose.heading+velocity.omega*.02);
    }
    assert(partial.Status()==mayhem::RunStatus::Failed&&partial.ActiveState()=="collect");
    // Bindings take precedence over RobotHooks; everything else still reaches the hooks.
    Hooks fallback; fallback.hasPiece=false;
    mayhem::AutoRunner mixed(mayhem_generated::routine_0::routine,fallback);
    mixed.Bind("intake.acquire",mayhem::Instant([&]{acquires++;})).BindSignal("pieceDetected",[]{return mayhem::SignalValue{true};});
    assert(mixed.Start());
    pose=mayhem_generated::startPose;velocity={};
    for(int i=0;i<1500&&mixed.Status()==mayhem::RunStatus::Running;i++) {
      velocity=mixed.Tick(pose,velocity,.02);
      pose.x+=velocity.vx*.02;pose.y+=velocity.vy*.02;pose.heading=mayhem::Wrap(pose.heading+velocity.omega*.02);
    }
    assert(mixed.Status()==mayhem::RunStatus::Completed&&acquires==2&&fallback.starts==1&&fallback.ends==1);  // shooter.fire via hooks
  }
  // onTimeout Succeed: a fixed action window ends the step as done; Fail (default) fails.
  {
    int ticks=0,ends=0;
    const mayhem::AutoNode window[]={
      {"aim",mayhem::NodeKind::Custom,{},.5,"aim",{},nullptr,0,-1,false,mayhem::TimeoutOutcome::Succeed},
      {"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition next[]={{"t","aim","done",[](const mayhem::RobotHooks&){return true;}}};
    mayhem::AutoRunner timed({"w","aim",window,2,next,1});
    timed.Bind("aim",{{},[&]{ticks++;return mayhem::ActionStatus::Running;},[&](bool){ends++;}});
    assert(timed.Start());
    for(int i=0;i<100&&timed.Status()==mayhem::RunStatus::Running;i++) timed.Tick({},{},.02);
    assert(timed.Status()==mayhem::RunStatus::Completed&&ticks==24&&ends==1);  // 25th tick reaches 0.5 s
    mayhem::AutoNode strict[]={window[0],window[1]}; strict[0].onTimeout=mayhem::TimeoutOutcome::Fail;
    mayhem::AutoRunner failing({"w","aim",strict,2,next,1});
    failing.Bind("aim",{{},[]{return mayhem::ActionStatus::Running;},{}});
    assert(failing.Start());
    for(int i=0;i<100&&failing.Status()==mayhem::RunStatus::Running;i++) failing.Tick({},{},.02);
    assert(failing.Status()==mayhem::RunStatus::Failed);
    // A pose step never succeeds by timing out.
    mayhem::AutoNode pose[]={{"go",mayhem::NodeKind::Pose,{{9,0,0}},.5,"",{}},window[1]}; pose[0].onTimeout=mayhem::TimeoutOutcome::Succeed;
    const mayhem::AutoTransition arrive[]={{"t","go","done",[](const mayhem::RobotHooks&){return true;}}};
    mayhem::AutoRunner drive({"p","go",pose,2,arrive,1});
    assert(drive.Start());
    for(int i=0;i<100&&drive.Status()==mayhem::RunStatus::Running;i++) drive.Tick({},{},.02);
    assert(drive.Status()==mayhem::RunStatus::Failed);
  }
  // Path events reach bound actions (begin only).
  {
    const mayhem::PathMarker events[]={{mayhem::MarkerKind::Event,.5,0,"intake.on",true}};
    mayhem::Goal g{{2,0,0}}; g.markers=events; g.markerCount=1;
    const mayhem::AutoNode nodes[]={{"go",mayhem::NodeKind::Pose,g,5,"",{}},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition arrive[]={{"t","go","done",[](const mayhem::RobotHooks&){return true;}}};
    mayhem::AutoRunner r({"e","go",nodes,2,arrive,1});
    assert(r.UnboundReport()=="event intake.on (node go)\n");
    int on=0; r.Bind("intake.on",mayhem::Instant([&]{on++;}));
    assert(r.Start());
    mayhem::Pose at;mayhem::Velocity v;
    for(int i=0;i<1000&&r.Status()==mayhem::RunStatus::Running;i++){v=r.Tick(at,v,.02);at.x+=v.vx*.02;at.y+=v.vy*.02;}
    assert(r.Status()==mayhem::RunStatus::Completed&&on==1);
  }
  // A pass-through step whose exit is conditional ("go through the approach point if the arm
  // is up, otherwise wait there"): while the guard is false the path ends at the approach and
  // the robot slows to it and waits; once it is true the robot hands off and drives on.
  {
    struct Arm final : mayhem::RobotHooks {
      bool up=false; int guards=0;
      mayhem::SignalValue Signal(std::string_view key) const override {
        return key=="superstructure.atGoal" ? mayhem::SignalValue{up} : mayhem::SignalValue{};
      }
      void GuardEvaluated(std::string_view id,bool) override {if(id=="armUp") guards++;}
    };
    struct Run {double maxX=-1e9, speedAtHandoff=-1, waitSpeed=-1; bool completed=false; int guardsBeforeArrival=-1; std::string stateAtArmUp;};
    // lead: optional always-chained point before the approach. armUpAt: time the arm is up (<0 never).
    auto run=[](bool lead,double armUpAt) {
      mayhem::Goal leadGoal{{1.5,0,0}};
      mayhem::Goal approach{{3,0,0}}; approach.handoffRadius=.4;
      mayhem::Goal reef{{5,0,0}};
      const mayhem::AutoNode nodes[]={
        {"lead",mayhem::NodeKind::Pose,leadGoal,15,"",{},nullptr,0,1,true},
        {"approach",mayhem::NodeKind::Pose,approach,15,"",{},nullptr,0,-1,true},
        {"reef",mayhem::NodeKind::Pose,reef,15,"",{}},
        {"done",mayhem::NodeKind::Finish,{},1,"",{}}};
      const mayhem::AutoTransition edges[]={
        {"go","lead","approach",[](const mayhem::RobotHooks&){return true;}},
        {"armUp","approach","reef",[](const mayhem::RobotHooks& h){return mayhem::Compare(h.Signal("superstructure.atGoal"),mayhem::CompareOp::Eq,true).value_or(false);}},
        {"score","reef","done",[](const mayhem::RobotHooks&){return true;}}};
      Arm arm; mayhem::AutoRunner r({"wait",lead?"lead":"approach",nodes,4,edges,3},arm);
      mayhem::Pose pose{0,0,0}; mayhem::Velocity v; Run out;
      arm.up=armUpAt==0; r.Start();
      for(int i=0;i<1500&&r.Status()==mayhem::RunStatus::Running;i++){
        const double t=i*.02;
        if(armUpAt>0&&t>=armUpAt&&!arm.up) {arm.up=true; out.stateAtArmUp=std::string(r.ActiveState()); out.waitSpeed=std::hypot(v.vx,v.vy);}
        const bool before=r.ActiveState()!="reef";
        v=r.Tick(pose,v,.02);
        if(before&&r.ActiveState()=="reef"&&out.speedAtHandoff<0) out.speedAtHandoff=std::hypot(v.vx,v.vy);
        if(out.guardsBeforeArrival<0&&std::hypot(pose.x-3,pose.y)<=.4) out.guardsBeforeArrival=arm.guards;
        pose.x+=v.vx*.02;pose.y+=v.vy*.02;pose.heading=mayhem::Wrap(pose.heading+v.omega*.02);
        if(r.ActiveState()!="reef"&&r.ActiveState()!="done") out.maxX=std::max(out.maxX,pose.x);
      }
      out.completed=r.Status()==mayhem::RunStatus::Completed;
      return out;
    };
    for(bool lead:{false,true}) {
      // Arm never up in time: the robot stops at the approach (no overshoot) and waits there.
      const Run waiting=run(lead,6);
      assert(waiting.completed);
      assert(waiting.maxX<=3.03);
      assert(waiting.stateAtArmUp=="approach"&&waiting.waitSpeed<.05);
      // The lookahead probe does not report guards; only the arrival evaluation does.
      assert(waiting.guardsBeforeArrival==0);
      // Arm already up: the robot drives through the approach at speed.
      const Run through=run(lead,0);
      assert(through.completed&&through.speedAtHandoff>2);
      // Arm comes up while the robot is still slowing for the approach: it hands off and
      // carries on without stopping.
      const Run late=run(lead,.8);
      assert(late.completed&&late.stateAtArmUp=="approach"&&late.waitSpeed>.3);
      assert(late.speedAtHandoff>.3&&late.maxX<=3.03);
    }
  }
  // Braking profile (Constraints::stopDeceleration, AutoRunner::SetStopDeceleration): a robot
  // that brakes at only 2 m/s^2 overshoots the P law's stop point and crawls back; with the
  // profile it arrives on the point, sooner.
  {
    struct Arrival {double overshoot=0, time=-1; bool completed=false;};
    // The drivetrain follows the command at no more than `brake` m/s^2 (an anti-tip limit).
    auto run=[](double stopDeceleration,bool live,double brake) {
      mayhem::Constraints c; c.stopDeceleration=stopDeceleration;
      mayhem::Goal stop{{3,0,0}}; stop.settleTime=.1;  // arrived means stopped on the point
      const mayhem::AutoNode nodes[]={{"go",mayhem::NodeKind::Pose,stop,15,"",c},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
      const mayhem::AutoTransition arrive[]={{"t","go","done",[](const mayhem::RobotHooks&){return true;}}};
      mayhem::AutoRunner r({"brake","go",nodes,2,arrive,1});
      int asked=0;
      if(live) r.SetStopDeceleration([&](const mayhem::StopQuery& q){
        asked++; assert(q.node&&q.node->id=="go"&&q.end.x==3&&std::abs(q.remaining-(3-q.pose.x))<1e-9);
        return .9*brake;});
      assert(r.Start());
      mayhem::Pose pose; mayhem::Velocity v; Arrival out;
      for(int i=0;i<1500&&r.Status()==mayhem::RunStatus::Running;i++) {
        const auto command=r.Tick(pose,v,.02);
        v.vx+=std::clamp(command.vx-v.vx,-brake*.02,brake*.02);
        pose.x+=v.vx*.02; out.overshoot=std::max(out.overshoot,pose.x-3); out.time=(i+1)*.02;
      }
      out.completed=r.Status()==mayhem::RunStatus::Completed;
      assert(!live||asked>0);
      return out;
    };
    const Arrival plain=run(0,false,2), profiled=run(1.8,false,2), supplied=run(0,true,2), lower=run(6,true,2);
    assert(plain.overshoot>.05);
    for(const Arrival& a:{profiled,supplied,lower}) assert(a.completed&&a.overshoot<.005&&a.time<plain.time-.3);
    // A robot that can brake as hard as the P law asks is not slowed by a matching profile.
    const Arrival strong=run(0,false,12), strongProfiled=run(12,false,12);
    assert(strong.completed&&strongProfiled.completed&&strong.overshoot<.005&&strongProfiled.overshoot<.005&&strongProfiled.time<strong.time+.2);
  }
  // Exits checked every tick (AutoTransition::interrupt): driveToPoint raced with a condition.
  // The step is left while still driving, the next path starts from the live velocity, and the
  // plain exit is still taken on arrival when the condition never comes true.
  {
    struct Run {std::string after; double speedAtExit=-1, xAtExit=-1; bool completed=false; int ends=0;};
    auto run=[](double seenAt) {
      bool seen=false; int ends=0;
      const std::string_view during[]={"intake"};
      const mayhem::AutoNode nodes[]={
        {"pickup",mayhem::NodeKind::Pose,{{5,0,0}},15,"",{},during,1},
        {"score",mayhem::NodeKind::Pose,{{2,1,0}},15,"",{}},
        {"missed",mayhem::NodeKind::Pose,{{5,1,0}},15,"",{}},
        {"done",mayhem::NodeKind::Finish,{},1,"",{}}};
      const mayhem::AutoTransition edges[]={
        {"got","pickup","score",[](const mayhem::RobotHooks& h){return mayhem::Compare(h.Signal("seen"),mayhem::CompareOp::Eq,true).value_or(false);},true},
        {"none","pickup","missed",[](const mayhem::RobotHooks&){return true;}},
        {"a","score","done",[](const mayhem::RobotHooks&){return true;}},
        {"b","missed","done",[](const mayhem::RobotHooks&){return true;}}};
      mayhem::AutoRunner r({"race","pickup",nodes,4,edges,4});
      r.BindSignal("seen",[&]{return mayhem::SignalValue{seen};});
      r.Bind("intake",{{},[]{return mayhem::ActionStatus::Running;},[&](bool){ends++;}});
      assert(r.Start());
      mayhem::Pose pose; mayhem::Velocity v; Run out;
      for(int i=0;i<2000&&r.Status()==mayhem::RunStatus::Running;i++) {
        if(seenAt>=0&&i*.02>=seenAt) seen=true;
        const bool before=r.ActiveState()=="pickup";
        v=r.Tick(pose,v,.02);
        if(before&&r.ActiveState()!="pickup") {out.after=std::string(r.ActiveState());out.speedAtExit=std::hypot(v.vx,v.vy);out.xAtExit=pose.x;}
        pose.x+=v.vx*.02;pose.y+=v.vy*.02;
      }
      out.completed=r.Status()==mayhem::RunStatus::Completed; out.ends=ends;
      return out;
    };
    const Run early=run(.8);
    assert(early.completed&&early.after=="score"&&early.xAtExit<4&&early.speedAtExit>2&&early.ends==1);
    const Run never=run(-1);
    assert(never.completed&&never.after=="missed"&&never.xAtExit>4.95&&never.ends==1);
    // True from the start: left on the first tick.
    const Run atOnce=run(0);
    assert(atOnce.completed&&atOnce.after=="score"&&atOnce.xAtExit==0);
    // An action step is left the same way, before its action is done.
    bool stop=false; int ended=0;
    const mayhem::AutoNode wait[]={{"wait",mayhem::NodeKind::Action,{},5,"hold",{}},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition leave[]={{"x","wait","done",[](const mayhem::RobotHooks& h){return mayhem::Compare(h.Signal("stop"),mayhem::CompareOp::Eq,true).value_or(false);},true}};
    mayhem::AutoRunner w({"w","wait",wait,2,leave,1});
    w.BindSignal("stop",[&]{return mayhem::SignalValue{stop};}).Bind("hold",{{},[]{return mayhem::ActionStatus::Running;},[&](bool){ended++;}});
    assert(w.Start()); for(int i=0;i<10;i++) w.Tick({},{},.02);
    assert(w.Status()==mayhem::RunStatus::Running);
    stop=true; w.Tick({},{},.02);
    assert(w.Status()==mayhem::RunStatus::Completed&&ended==1);
  }
  // Look-ahead through a conditional pass-through whose exit is open: the step after it is the
  // first true exit, so with anticipateSpeedCaps the robot is at that step's cap when it
  // crosses the gate (it used to cross at full speed and brake afterwards).
  {
    bool left=false;
    mayhem::Constraints fast; fast.anticipateSpeedCaps=true;
    mayhem::Constraints slow=fast; slow.maxVelocity=1;
    mayhem::Goal gate{{3,0,0}}; gate.handoffRadius=.4;
    const mayhem::AutoNode nodes[]={
      {"gate",mayhem::NodeKind::Pose,gate,15,"",fast,nullptr,0,-1,true},
      {"left",mayhem::NodeKind::Pose,{{5,1,0}},15,"",fast},
      {"slow",mayhem::NodeKind::Pose,{{5,0,0}},15,"",slow},
      {"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition edges[]={
      {"l","gate","left",[](const mayhem::RobotHooks& h){return mayhem::Compare(h.Signal("left"),mayhem::CompareOp::Eq,true).value_or(false);}},
      {"s","gate","slow",[](const mayhem::RobotHooks&){return true;}},
      {"a","left","done",[](const mayhem::RobotHooks&){return true;}},
      {"b","slow","done",[](const mayhem::RobotHooks&){return true;}}};
    for(bool goLeft:{false,true}) {
      left=goLeft;
      mayhem::AutoRunner r({"gate","gate",nodes,4,edges,4});
      r.BindSignal("left",[&]{return mayhem::SignalValue{left};});
      assert(r.Start());
      mayhem::Pose pose; mayhem::Velocity v; double crossing=-1, top=0;
      for(int i=0;i<1500&&r.Status()==mayhem::RunStatus::Running;i++) {
        const bool before=r.ActiveState()=="gate";
        v=r.Tick(pose,v,.02);
        if(before&&r.ActiveState()!="gate") crossing=std::hypot(v.vx,v.vy);
        if(before) top=std::max(top,std::hypot(v.vx,v.vy));
        pose.x+=v.vx*.02;pose.y+=v.vy*.02;
      }
      assert(r.Status()==mayhem::RunStatus::Completed&&top>2.5);
      // The capped step: crossed at its cap. The uncapped one: crossed at speed.
      if(goLeft) assert(crossing>2.5); else assert(crossing<=1.0+1e-6);
    }
  }
  // Event markers by distance (to the step's goal, or to a field point), and `hold` markers:
  // the action is begun at the marker and ticked until it succeeds.
  {
    const mayhem::PathMarker events[]={
      {mayhem::MarkerKind::Event,1,0,"near.point",true,mayhem::MarkerTrigger::PointDistance,.5,1,.3},
      {mayhem::MarkerKind::Event,1,0,"arm.up",true,mayhem::MarkerTrigger::GoalDistance,1.2,0,0,true}};
    mayhem::Goal g{{4,0,0}}; g.markers=events; g.markerCount=2;
    const mayhem::AutoNode nodes[]={{"go",mayhem::NodeKind::Pose,g,10,"",{}},{"done",mayhem::NodeKind::Finish,{},1,"",{}}};
    const mayhem::AutoTransition arrive[]={{"t","go","done",[](const mayhem::RobotHooks&){return true;}}};
    for(int refusals:{6,100000}) {
      mayhem::AutoRunner r({"e","go",nodes,2,arrive,1});
      mayhem::Pose at; double pointAt=-1, armAt=-1; int begins=0, ticks=0, done=0, cancelled=0;
      r.Bind("near.point",mayhem::Instant([&]{assert(pointAt<0); pointAt=at.x;}));
      r.Bind("arm.up",{[&]{begins++; armAt=at.x;},
                        [&]{return ++ticks>refusals?mayhem::ActionStatus::Succeeded:mayhem::ActionStatus::Running;},
                        [&](bool c){(c?cancelled:done)++;}});
      assert(r.Unbound().empty()&&r.Start());
      mayhem::Velocity v;
      for(int i=0;i<1000&&r.Status()==mayhem::RunStatus::Running;i++){v=r.Tick(at,v,.02);at.x+=v.vx*.02;at.y+=v.vy*.02;}
      assert(r.Status()==mayhem::RunStatus::Completed);
      // Fired on the first tick within 0.5 m of (1, 0.3), and within 1.2 m of the goal.
      assert(pointAt>.5&&pointAt<=.6+.09&&armAt>2.7&&armAt<=2.8+.09&&begins==1);
      if(refusals==6) assert(ticks==7&&done==1&&cancelled==0);   // ticked until it succeeded
      else assert(ticks>20&&done==0&&cancelled==1);              // still running when the step exits
    }
  }
  std::cout<<"Auto runner checks passed\n";
}
