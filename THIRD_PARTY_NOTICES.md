# Third-party notices

## BLine-Lib

Mayhem's path follower (`app/src/suite/core/runtime.ts` and `lib-cpp/include/mayhem/pose_controller.hpp`) is ported from BLine-Lib (https://github.com/edanliahovetsky/BLine-Lib): `FollowPath`, `RotationProgress` and `ChassisRateLimiter`.

```
BSD 3-Clause License

Copyright (c) 2025, Edan Liahovetsky
Copyright (c) 2025, Rebel Robotics (FRC 2638)

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

### Attributions

This project incorporates limited portions of code from the following open-source projects:

- **WPILib**  
  © 2009–2024 FIRST and other WPILib contributors.  
  Licensed under the BSD 3-Clause License.  
  Source: <https://github.com/wpilibsuite/allwpilib>

- **PathPlanner**  
  Includes a copy of the `FlippingUtil` class.  
  © mjansen4857 / PathPlanner contributors.  
  Licensed under the MIT License.  
  Source: <https://github.com/mjansen4857/pathplanner>
```

## BLine-Web

Mayhem's path preview and automatic constraint generation
(`app/src/suite/core/pathing/`) and the freehand draw tool's stroke
simplification (`app/src/suite/core/sketch.ts`, from BLine-Web's
`src/core/pathProfile/curveProfile.ts`) are derived from BLine-Web 1.0.0, commit
`1e440b419dc33499e447fbca4ddc2fea69497b71`
(https://github.com/edanliahovetsky/BLine-Web), and modified. BLine-Web is
under the same BSD 3-Clause license and copyright holders as BLine-Lib; the
full text is reproduced above.
