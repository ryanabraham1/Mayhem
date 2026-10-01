# Fuel sim

**Fuel sim** in the toolbar simulates the FUEL on the field during playback. Robots push it around, and an extended intake takes it in only as fast as its intake rate. Everything else it touches gets shoved, the way a real intake bulldozes part of a pile.

![The Fuel sim panel](/img/fuel-sim.jpg)

The timeline shows how much fuel we're holding and keeps running after the robots stop until the pushed fuel has rolled to rest.

## Our robot

Our robot uses its solved path and its **Intake extended** spans. Set its *intake rate* (fuel per second) and *capacity* (0 = no limit) in the Fuel sim panel. An out-of-date path doesn't take part until you generate it again.

## Other robots

Add allies and opponents from the panel. Each drives a smooth curve through its points at a set max speed and acceleration, facing along the curve, with its intake out at the front.

- Click its path to select it, then drag its points to reshape the path or drag the robot itself to move the whole path.
- Double-click the field to add a point at the end, <kbd>⇧</kbd>-click a point to remove it, and press <kbd>Delete</kbd> to remove the robot.
- The copy button mirrors it to the other alliance.

## What blocks fuel

Fuel bounces off the field walls and, by default, off the obstacles paths avoid (the hubs, trench walls and towers). To change that for one obstacle, select it in **Field** mode and set **Fuel sim** to *Blocks fuel* or *Fuel passes through*.

The 2026 preset's bumps are disabled for paths (robots drive over them) but block fuel. With the fuel sim on, obstacles that only block fuel are outlined in amber.

## Good to know

- The other robots and intake settings are saved in the project file. They never make a path out of date, and the solver ignores them.
- It's a 2D, top-down model. Fuel doesn't stack or fly, and robots don't collide with each other.
- The FUEL properties come from FIRST and AndyMark's 2026 Scoring Element Testing Report (215 g, 5.91 in). Rolling friction and bounce values are estimates.
