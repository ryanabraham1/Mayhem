import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLiveRobot } from "./useLiveRobot";

export interface RobotConfig {
  team: number;
  /** Overrides the address derived from the team number when set. */
  address: string;
}
const KEY = "mayhem.robot.v1";
const defaults: RobotConfig = { team: 3256, address: "" };

function loadConfig(): RobotConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      team:
        Number.isInteger(saved.team) && saved.team > 0 && saved.team < 100000
          ? saved.team
          : defaults.team,
      address: typeof saved.address === "string" ? saved.address : "",
    };
  } catch {
    return defaults;
  }
}

/** Standard roboRIO addresses for a team, most specific first. */
export function robotAddresses(team: number) {
  const te = Math.floor(team / 100),
    am = team % 100;
  return [
    `roborio-${team}-frc.local`,
    `10.${te}.${am}.2`,
    "172.22.11.2",
  ];
}

function useRobotState() {
  const [config, setConfig] = useState(loadConfig);
  const host = config.address.trim() || robotAddresses(config.team)[0];
  const live = useLiveRobot(host);
  const update = useCallback((change: Partial<RobotConfig>) => {
    setConfig((previous) => {
      const next = { ...previous, ...change };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return useMemo(
    () => ({ config, update, host, live }),
    [config, update, host, live],
  );
}
export type RobotState = ReturnType<typeof useRobotState>;
const RobotContext = createContext<RobotState | null>(null);

export function RobotProvider({ children }: { children: ReactNode }) {
  const value = useRobotState();
  return (
    <RobotContext.Provider value={value}>{children}</RobotContext.Provider>
  );
}
export function useRobot() {
  const value = useContext(RobotContext);
  if (!value) throw new Error("useRobot must be used inside RobotProvider.");
  return value;
}
