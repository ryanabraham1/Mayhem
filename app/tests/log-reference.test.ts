// @vitest-environment node
import { expect, it } from "vitest";
import { analyze, type Recording } from "../src/suite/core/analysis";
it("recognizes current robot outputs without requiring Mayhem-specific names or fabricating missing power", () => {
  const recording: Recording = { name: "2026 reference convention", duration: 2, warnings: [], channels: [
    { name: "/RealOutputs/SystemStats/BatteryVoltage", type: "double", samples: [{time:0,value:12}, {time:2,value:12}] },
    { name: "/RealOutputs/SystemStats/BrownedOut", type: "boolean", samples: [{time:0,value:false}] },
    { name: "/RealOutputs/LoopPeriodMS", type: "double", samples: [{time:0,value:28}, {time:0.2,value:20}] },
    { name: "/RealOutputs/Superstructure/State", type: "string", samples: Array.from({length:12}, (_,i)=>({time:i*0.06,value:i%2?"REV":"INTAKE"})) },
    { name: "/Shooter/shooterSupplyCurrent", type: "double", samples: [{time:0,value:70}, {time:2,value:70}] },
  ] };
  const result = analyze(recording);
  expect(result.power.minVoltage).toBe(12);
  expect(result.mapping.current).toBeUndefined();
  expect(result.power.energyWh).toBeUndefined();
  expect(result.coverage).toContainEqual(expect.stringContaining("Total current missing"));
  expect(result.findings.map(f=>f.title)).toEqual(expect.arrayContaining(["Control loop period over 25 ms", "Rapid state switching"]));
});
it("keeps custom future-season power mappings independent of reference names", () => {
  const result = analyze({name:"future", duration:2, warnings:[],channels:[
    {name:"Electrical/BusVolts",type:"double",samples:[{time:0,value:12},{time:2,value:12}]},
    {name:"Electrical/BusAmps",type:"double",samples:[{time:0,value:60},{time:2,value:60}]},
  ]}, {voltage:"Electrical/BusVolts",current:"Electrical/BusAmps"});
  expect(result.power.energyWh).toBeCloseTo(0.4);
});
