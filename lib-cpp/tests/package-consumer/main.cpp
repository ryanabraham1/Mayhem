#include <mayhem/alliance.hpp>
#include <mayhem/auto_runner.hpp>
#include <mayhem/state_machine.hpp>
#include <mayhem/state_observer.hpp>
#include <mayhem/version.hpp>
namespace {
bool Go(const mayhem::SignalSource& s) { return mayhem::Compare(s.Signal("go"), mayhem::CompareOp::Eq, true).value_or(false); }
const mayhem::MachineState kStates[] = {{"Idle"}, {"Running"}};
const mayhem::MachineTransition kEdges[] = {{"start", "Idle", "Running", Go}};
}  // namespace
int main() {
  mayhem::PoseController controller;
  controller.Reset({});
  const auto result = controller.Calculate({}, {}, mayhem::Goal{{1, 0, 0}}, {}, .02);
  mayhem::StateMachine machine({"M", "Idle", kStates, 2, kEdges, 1},
                               [](std::string_view key) -> mayhem::SignalValue { return key == "go"; });
  machine.Tick(.02);
  const auto red = mayhem::TransformPose({1, 2, 0}, mayhem::FieldTransform::Flip, 16, 8);
  return result.valid && result.command.vx > 0 && machine.State() == "Running" && red.x == 15 &&
                 !mayhem::kCppVersion.empty()
             ? 0
             : 1;
}
