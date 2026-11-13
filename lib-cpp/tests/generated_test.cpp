// Exercises the exporter's output (examples/suite/competition.hpp, kept current by
// `node scripts/mayhem.mjs cpp examples/suite/competition.mayhem.json --check ...`).
#include "../../examples/suite/competition.hpp"
#include "mayhem/alliance.hpp"
#include <cassert>
#include <iostream>
#include <string>
#include <type_traits>
#include <variant>

int main() {
  namespace gen = mayhem_generated;
  // Routines: chooser label, graph and start pose, iterable and searchable.
  static_assert(gen::routines.size() == 1);
  assert(gen::routines[0].name == "Collect & score" && gen::routines[0].name == gen::routine_0::name);
  assert(gen::routines[0].routine.id == "collect-score" && gen::routines[0].startPose.x == gen::routine_0::startPose.x);
  assert(mayhem::FindRoutine(gen::routines, "Collect & score") == &gen::routines[0]);
  assert(mayhem::FindRoutine(gen::routines, "collect-score") == &gen::routines[0]);
  assert(!mayhem::FindRoutine(gen::routines, "missing"));
  // Autonomous manifest: canonical JSON (sorted keys) with qualified transition IDs.
  const auto autonomous = gen::autonomous::manifest.Text();
  assert(autonomous.rfind("{\"format\":\"mayhem-machine\",\"id\":\"Autonomous\"", 0) == 0);
  assert(autonomous.find("\"collect-score/") != std::string::npos);
  // Machines: the Intake graph runs through StateMachine via its alias.
  static_assert(gen::machines.size() == 1);
  assert(gen::machines[0].id == "Intake" && gen::Intake::machine.id == "Intake");
  bool requested = false, hasPiece = false;
  mayhem::StateMachine intake(gen::Intake::machine, [&](std::string_view key) -> mayhem::SignalValue {
    if (key == "intake.requested") return requested;
    if (key == "intake.hasPiece") return hasPiece;
    return {};  // intake.release unknown: fails closed
  });
  assert(intake.Valid() && intake.State() == "Idle");
  assert(!intake.Tick(.02));
  requested = true; assert(intake.Tick(.02) && intake.State() == "Acquiring");
  hasPiece = true; assert(intake.Tick(.02) && intake.State() == "Holding");
  for (int i = 0; i < 10; ++i) assert(!intake.Tick(.02));
  // The typed API over the same graph: State enum, Inputs struct, typed guards.
  gen::Intake::Machine typed;
  using State = gen::Intake::State;
  static_assert(std::is_same_v<decltype(typed.In().intake_requested), bool>);
  assert(typed.Is(State::Idle) && gen::Intake::Machine::Name(State::Holding) == "Holding");
  typed.In().intake_requested = true;
  assert(typed.Settle(.02) == 1 && typed.Current() == State::Acquiring);
  typed.In().intake_hasPiece = true;
  assert(typed.Settle(.02) == 1 && typed.Is(State::Holding));
  assert(std::get<bool>(typed.Untyped().Signal("intake.hasPiece")));
  // Declared inputs are exported for logging.
  static_assert(gen::Intake::inputs.size() == 3);
  assert(gen::Intake::machine.inputCount == 3 && gen::Intake::machine.inputs[0].key == "intake.requested" &&
         gen::Intake::machine.inputs[0].type == mayhem::InputType::Boolean && !gen::Intake::machine.inputs[0].event);
  const auto text = gen::Intake::machine.manifest.Text();
  assert(text.rfind("{\"format\":\"mayhem-machine\",\"id\":\"Intake\"", 0) == 0 && text.back() == '}');
  // Field size feeds AllianceRoutine.
  mayhem::AllianceRoutine red(gen::routines[0], gen::fieldLength, gen::fieldWidth, mayhem::FieldTransform::Flip);
  assert(std::abs(red.StartPose().x - (gen::fieldLength - gen::routine_0::startPose.x)) < 1e-12);
  std::cout << "Generated header checks passed\n";
}
