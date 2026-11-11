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
it("runs agent-authored project rules with durations and allows replacing defaults", () => {
  const r:Recording={name:"custom",duration:2,warnings:[],channels:[{name:"Shooter/Ready",type:"boolean",samples:[{time:0,value:false},{time:1.2,value:true}]}]};
  const policy={defaultRules:false,rules:[{id:"shooter-not-ready",channel:"Shooter/Ready",op:"eq",value:false,duration:1,severity:"warning",title:"Shooter took too long",detail:"Readiness stayed false for one second."}]};
  expect(analyze(r,undefined,policy).findings).toMatchObject([{id:"rule:shooter-not-ready:0",start:0,end:1.2,title:"Shooter took too long"}]);
  expect(analyze(r,undefined,{...policy,rules:[{...policy.rules[0],duration:1.5}]}).findings).toEqual([]);
  expect(()=>analyze(r,undefined,{rules:[{...policy.rules[0],duration:-1}]})).toThrow(/rule/);
});
