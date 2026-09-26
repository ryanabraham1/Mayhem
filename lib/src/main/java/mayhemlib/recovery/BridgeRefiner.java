package mayhemlib.recovery;

import java.util.Optional;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectorySample;

/**
 * Optional second stage that improves a coarse bridge (e.g. with a numerical optimizer). The
 * refined bridge must start at {@code start} (the coarse bridge's state at the hand-off time) and
 * end at {@code target}. Implementations run on a background thread.
 */
public interface BridgeRefiner {
  Optional<Bridge> refine(TrajectorySample start, TrajectorySample target, double joinTime,
      double coarseRemaining, RecoveryData rec);
}
