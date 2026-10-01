# Checking a path

![Scrubbing a generated path on the timeline](/img/playback.jpg)

## Timeline

The timeline at the bottom plays the path (<kbd>Space</kbd>). Tick marks show waypoints (gray) and markers (amber). The speed legend at the bottom of the field shows what the path colors mean.

## Graphs

The graph button at the right of the timeline shows speed, acceleration, estimated motor current per module (against your current limit) and wheel force. Use it to see what is limiting a path: current, friction, or a constraint you set.

## Blue and Red

**Blue / Red** in the top bar previews the red-alliance version. Paths are always authored for blue and flipped at runtime. See [Splits and alliance flipping](/lib/splits-and-alliance#alliance-flipping).

## Before you deploy

- The path is not marked out of date.
- Waypoints and markers sit at the right times on the timeline.
- Estimated current stays under your limit in the graph.
- Both alliances look right.
