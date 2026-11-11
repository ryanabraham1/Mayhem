import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NT4Observer, type LiveSnapshot } from "./core/nt4.ts";
export function useLiveRobot(host: string) {
  const client = useRef<NT4Observer | null>(null),
    topics = useRef<string[]>([]);
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({
    status: "disconnected",
    topics: {},
  });
  useEffect(() => {
    client.current?.disconnect();
    client.current = null;
    setSnapshot({ status: "disconnected", topics: {} });
    return () => {
      client.current?.disconnect();
      client.current = null;
    };
  }, [host]);
  const setTopics = useCallback((next: string[]) => {
    topics.current = next;
    client.current?.setExtraTopics(next);
  }, []);
  const connect = useCallback(() => {
    client.current?.disconnect();
    let next: NT4Observer;
    next = new NT4Observer(host, (value) => {
      if (client.current === next) setSnapshot(value);
    });
    next.setExtraTopics(topics.current);
    client.current = next;
    next.connect();
  }, [host]);
  const disconnect = useCallback(() => {
    client.current?.disconnect();
    client.current = null;
    setSnapshot({ status: "disconnected", topics: {} });
  }, []);
  return useMemo(
    () => ({ snapshot, connect, disconnect, setTopics }),
    [snapshot, connect, disconnect, setTopics],
  );
}
