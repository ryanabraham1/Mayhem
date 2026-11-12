#include "mayhem/state_machine.hpp"
#include "mayhem/auto_runner.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <map>
#include <new>
#include <string>
#include <vector>

// Count heap allocations to prove ticks do not allocate.
static std::size_t allocations = 0;
void* operator new(std::size_t size) {
  ++allocations;
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

namespace {
using mayhem::CompareOp;
using mayhem::SignalSource;
using mayhem::SignalValue;
bool Requested(const SignalSource& h) { return mayhem::Compare(h.Signal("requested"), CompareOp::Eq, true).value_or(false); }
bool Cancel(const SignalSource& h) { return mayhem::Compare(h.Signal("cancel"), CompareOp::Eq, true).value_or(false); }
bool NotCancel(const SignalSource& h) { return mayhem::Not(mayhem::Compare(h.Signal("cancel"), CompareOp::Eq, true)).value_or(false); }
bool Deadline(const SignalSource& h) { return mayhem::Compare(h.Signal("stateTime"), CompareOp::Gt, .5).value_or(false); }
bool Ready(const SignalSource& h) { return mayhem::Compare(h.Signal("speed"), CompareOp::Gt, 90.0).value_or(false); }

const mayhem::MachineState kStates[] = {{"IDLE"}, {"SPINNING"}, {"FEEDING"}, {"FAULT"}};
// Declaration order is priority: cancel beats readiness, readiness beats the deadline.
const mayhem::MachineTransition kEdges[] = {
  {"start", "IDLE", "SPINNING", Requested},
  {"cancel", "SPINNING", "IDLE", Cancel},
  {"ready", "SPINNING", "FEEDING", Ready},
  {"timeout", "SPINNING", "FAULT", Deadline},
  {"clear", "FAULT", "IDLE", NotCancel},
};
const std::string_view kParts[] = {"{\"id\":\"Shooter\",", "\"states\":[]}"};
constexpr mayhem::MachineView kMachine{"Shooter", "IDLE", kStates, 4, kEdges, 5, {kParts, 2}};

struct Inputs final : SignalSource {
  std::map<std::string, SignalValue, std::less<>> values;
  SignalValue Signal(std::string_view key) const override {
    const auto it = values.find(key); return it == values.end() ? SignalValue{} : it->second;
  }
};
struct Recorder final : mayhem::StateObserver {
  std::string described; std::vector<std::string> guards, log;
  void Describe(std::string_view json) { described = std::string(json); }
  void RegisterGuard(std::string transition, std::string input) { guards.push_back(transition + "|" + input); }
  void Enter(std::string_view m, std::string_view s, double t) override { log.push_back("enter " + std::string(m) + " " + std::string(s) + " " + std::to_string(int(t))); }
  void Guard(std::string_view, std::string_view e, std::string_view i, bool b, double) override { log.push_back("guard " + std::string(e) + " " + std::string(i) + (b ? " 1" : " 0")); }
  void Transition(std::string_view m, std::string_view e, std::string_view f, std::string_view s, double) override {
    log.push_back("transition " + std::string(m) + " " + std::string(e) + " " + std::string(f) + " " + std::string(s));
  }
  void GoalProgress(std::string_view, double, double, bool, double) override {}
};
// Observer sink that never allocates (for the allocation check).
struct Counter final : mayhem::StateObserver {
  int enters = 0, guards = 0, transitions = 0;
  void Enter(std::string_view, std::string_view, double) override { ++enters; }
  void Guard(std::string_view, std::string_view, std::string_view, bool, double) override { ++guards; }
  void Transition(std::string_view, std::string_view, std::string_view, std::string_view, double) override { ++transitions; }
  void GoalProgress(std::string_view, double, double, bool, double) override {}
};
}  // namespace

int main() {
  Inputs inputs;
  mayhem::StateMachine machine(kMachine, inputs);
  assert(machine.Valid() && machine.State() == "IDLE" && machine.StateIndex() == 0 && machine.StateTime() == 0);
  // Missing inputs fail closed: no transition, including through Not.
  assert(!machine.Tick(.02) && machine.State() == "IDLE");
  inputs.values["requested"] = 1.0;  // wrong type: still closed
  assert(!machine.Tick(.02));
  inputs.values["requested"] = true;
  assert(machine.Tick(.02) && machine.State() == "SPINNING" && machine.LastTransition() == "start" && machine.StateTime() == 0);
  // Built-in stateTime: at most one transition per tick, deadline after > 0.5 s.
  for (int i = 0; i < 24; ++i) assert(!machine.Tick(.02));
  assert(std::abs(machine.StateTime() - .48) < 1e-9 && std::get<double>(machine.Signal("stateTime")) == machine.StateTime());
  // Non-finite or negative dt never advances time, but guards still run.
  assert(!machine.Tick(std::numeric_limits<double>::quiet_NaN()) && !machine.Tick(-1));
  assert(std::abs(machine.StateTime() - .48) < 1e-9);
  // Priority: with cancel, readiness and the deadline (0.53 s) all true, cancel wins.
  inputs.values["cancel"] = true; inputs.values["speed"] = 95.0;
  assert(machine.Tick(.05) && machine.State() == "IDLE" && machine.LastTransition() == "cancel");
  assert(machine.Tick(.02) && machine.State() == "SPINNING");  // requested is still true
  inputs.values.erase("cancel");
  assert(machine.Tick(.02) && machine.State() == "FEEDING" && machine.LastTransition() == "ready");
  // Deadline path, then NOT(missing) stays closed until cancel is known false.
  machine.Reset();
  assert(machine.State() == "IDLE" && machine.LastTransition().empty());
  inputs.values["speed"] = 10.0;
  machine.Tick(.02);
  for (int i = 0; i < 26; ++i) machine.Tick(.02);
  assert(machine.State() == "FAULT" && machine.LastTransition() == "timeout");
  for (int i = 0; i < 5; ++i) assert(!machine.Tick(.02));
  inputs.values["cancel"] = false;
  assert(machine.Tick(.02) && machine.State() == "IDLE");

  // Callback signals; the built-in stateTime takes precedence over the callback.
  bool requested = false;
  mayhem::StateMachine callback(kMachine, [&](std::string_view key) -> SignalValue {
    if (key == "requested") return requested;
    if (key == "stateTime") return 1000.0;
    return {};
  });
  assert(!callback.Tick(.02));
  requested = true;
  assert(callback.Tick(.02) && callback.State() == "SPINNING");
  for (int i = 0; i < 10; ++i) callback.Tick(.02);
  assert(callback.State() == "SPINNING");

  // Observation: describe, register every guard, report enter/guard/transition.
  Recorder recorder;
  mayhem::StateMachine observed(kMachine, inputs);
  inputs.values = {{"requested", true}};
  observed.Attach(recorder, [] { return 3.0; });
  assert(recorder.described == "{\"id\":\"Shooter\",\"states\":[]}");
  assert(recorder.guards.size() == 5 && recorder.guards[0] == "start|condition" && recorder.guards[4] == "clear|condition");
  assert(recorder.log.size() == 1 && recorder.log[0] == "enter Shooter IDLE 3");
  observed.Tick(.02);
  assert(recorder.log.size() == 4 && recorder.log[1] == "guard start condition 1");
  assert(recorder.log[2] == "transition Shooter start IDLE SPINNING" && recorder.log[3] == "enter Shooter SPINNING 3");
  observed.Tick(.02);  // cancel/ready/timeout evaluated in order, all false
  assert(recorder.log.size() == 7 && recorder.log[4] == "guard cancel condition 0" && recorder.log[6] == "guard timeout condition 0");
  observed.Detach(); observed.Tick(.02);
  assert(recorder.log.size() == 7);

  // A missing initial state or transition endpoint makes the graph invalid.
  const mayhem::MachineTransition dangling[] = {{"bad", "IDLE", "NOWHERE", Requested}};
  mayhem::StateMachine broken({"Broken", "IDLE", kStates, 4, dangling, 1}, inputs);
  assert(!broken.Valid() && broken.State().empty() && !broken.Tick(.02) && !broken.Reset());
  mayhem::StateMachine noInitial({"Broken", "MISSING", kStates, 4, kEdges, 5}, inputs);
  assert(!noInitial.Valid() && noInitial.StateIndex() == -1);

  // No allocation per tick, with or without an observer, for StateMachine and AutoRunner.
  {
    Counter counter;
    bool want = false;
    mayhem::StateMachine quiet(kMachine, [&](std::string_view key) -> SignalValue {
      if (key == "requested") return want;
      if (key == "cancel") return !want;
      return 50.0;
    });
    quiet.Attach(counter);
    const std::size_t before = allocations;
    for (int i = 0; i < 2000; ++i) { want = (i / 40) % 2 == 0; quiet.Tick(.02); }
    assert(allocations == before && counter.transitions > 10 && counter.guards > 2000);

    struct Hooks final : mayhem::RobotHooks {
      mayhem::ActionStatus TickAction(std::string_view) override { return mayhem::ActionStatus::Succeeded; }
    } hooks;
    const std::string_view during[] = {"hold"};
    const mayhem::AutoNode nodes[] = {
      {"go", mayhem::NodeKind::Pose, {{3, 1, .5}}, 10, "", {}, during, 1},
      {"act", mayhem::NodeKind::Action, {}, 10, "act", {}, during, 1},
      {"done", mayhem::NodeKind::Finish, {}, 1, "", {}},
    };
    const mayhem::AutoTransition edges[] = {
      {"t1", "go", "act", [](const mayhem::RobotHooks&) { return true; }},
      {"t2", "act", "done", [](const mayhem::RobotHooks&) { return true; }},
    };
    mayhem::AutoRunner runner({"r", "go", nodes, 3, edges, 2}, hooks);
    runner.Attach(counter);
    const std::size_t start = allocations;
    mayhem::Pose pose; mayhem::Velocity v;
    for (int run = 0; run < 3; ++run) {
      pose = {}; v = {}; runner.Start();
      for (int i = 0; i < 1500 && runner.Status() == mayhem::RunStatus::Running; ++i) {
        v = runner.Tick(pose, v, i % 50 == 0 ? .3 : .02);
        pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
      }
      assert(runner.Status() == mayhem::RunStatus::Completed && runner.Overruns() > 0);
    }
    assert(allocations == start);
  }
  {
    // "*" transitions: checked at their position in every state but the target and `except`,
    // so a priority supervisor needs one transition per target. Observers see the real source.
    static const mayhem::MachineState states[] = {{"IDLE"}, {"SHOOT"}, {"INTAKE"}, {"HOME"}};
    static const std::string_view notHome[] = {"HOME"};
    static const mayhem::MachineTransition edges[] = {
      {"toHome", "*", "HOME", [](const SignalSource& h) { return mayhem::Compare(h.Signal("home"), CompareOp::Eq, true).value_or(false); }},
      {"toShoot", "*", "SHOOT", [](const SignalSource& h) { return mayhem::Compare(h.Signal("shoot"), CompareOp::Eq, true).value_or(false); }, notHome, 1},
      {"intake", "IDLE", "INTAKE", [](const SignalSource& h) { return mayhem::Compare(h.Signal("intake"), CompareOp::Eq, true).value_or(false); }},
      {"toIdle", "*", "IDLE", [](const SignalSource& h) { return mayhem::Compare(h.Signal("idle"), CompareOp::Eq, true).value_or(false); }},
    };
    Inputs in;
    mayhem::StateMachine m({"Super", "IDLE", states, 4, edges, 4}, in);
    Recorder rec;
    m.Attach(rec);
    in.values["idle"] = true;
    assert(m.Valid() && !m.Tick(.02) && m.State() == "IDLE");  // toIdle never leaves IDLE itself
    in.values["idle"] = false;
    in.values["shoot"] = true; in.values["intake"] = true;
    assert(m.Tick(.02) && m.State() == "SHOOT" && m.LastTransition() == "toShoot");  // priority over "intake"
    assert(rec.log.back() == "enter Super SHOOT 0" && rec.log[rec.log.size() - 2] == "transition Super toShoot IDLE SHOOT");
    assert(!m.Tick(.02) && m.State() == "SHOOT");  // toShoot does not leave SHOOT itself
    in.values["home"] = true;
    assert(m.Tick(.02) && m.State() == "HOME");
    in.values["home"] = false; in.values["idle"] = true;
    assert(m.Tick(.02) && m.State() == "IDLE");  // except HOME: toShoot is skipped, toIdle wins
    assert(rec.log[rec.log.size() - 2] == "transition Super toIdle HOME IDLE");
    static const std::string_view bogus[] = {"NOPE"};
    const mayhem::MachineTransition badExcept[] = {{"x", "*", "IDLE", nullptr, bogus, 1}};
    const mayhem::MachineTransition exceptOnPlain[] = {{"x", "SHOOT", "IDLE", nullptr, notHome, 1}};
    assert(!mayhem::StateMachine({"B", "IDLE", states, 4, badExcept, 1}, in).Valid());
    assert(!mayhem::StateMachine({"B", "IDLE", states, 4, exceptOnPlain, 1}, in).Valid());
  }
  std::cout << "State machine checks passed\n";
}
