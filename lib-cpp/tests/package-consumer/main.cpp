#include <mayhem/auto_runner.hpp>
#include <mayhem/state_observer.hpp>
int main() {
  mayhem::PoseController controller;
  controller.Reset({});
  const auto result = controller.Calculate({}, {}, mayhem::Goal{{1, 0, 0}}, {}, .02);
  return result.valid && result.command.vx > 0 ? 0 : 1;
}
