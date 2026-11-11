"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type NodeAlarm = {
  date: string;
  location: string;
  nodeId: string;
  nodeLabel: string;
  time: string;
};

type NodeAlarmContextValue = {
  alarms: Record<string, NodeAlarm>;
  setAlarm: (nodeId: string, alarm: NodeAlarm | null) => void;
};

const defaultContext: NodeAlarmContextValue = {
  alarms: {},
  setAlarm: () => undefined,
};

const NodeAlarmContext = createContext<NodeAlarmContextValue>(defaultContext);

function NodeAlarmBanner({ alarms, onDismiss }: { alarms: NodeAlarm[]; onDismiss: (nodeId: string) => void }) {
  if (!alarms.length) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed top-3 right-3 left-3 z-[60] flex flex-col gap-2">
      {alarms.map((alarm) => (
        <Alert aria-live="assertive" className="pointer-events-auto shadow-lg" key={alarm.nodeId} variant="destructive">
          <AlertAction>
            <Button
              aria-label={`Dismiss ${alarm.nodeLabel} displacement alert`}
              onClick={() => onDismiss(alarm.nodeId)}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </AlertAction>
          <AlertTitle>{alarm.nodeLabel} is displaced</AlertTitle>
          <AlertDescription>
            {alarm.nodeLabel} is displaced at {alarm.location} · {alarm.time} · {alarm.date}. Email notification is not connected yet.
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

export function NodeAlarmProvider({ children }: { children: ReactNode }) {
  const [alarms, setAlarms] = useState<Record<string, NodeAlarm>>({});
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  const setAlarm = useCallback((nodeId: string, alarm: NodeAlarm | null) => {
    setDismissed((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    setAlarms((current) => {
      if (!alarm) {
        const next = { ...current };
        delete next[nodeId];
        return next;
      }
      return { ...current, [nodeId]: alarm };
    });
  }, []);

  const dismissAlarm = useCallback((nodeId: string) => {
    setDismissed((current) => ({ ...current, [nodeId]: true }));
  }, []);

  const value = useMemo(() => ({ alarms, setAlarm }), [alarms, setAlarm]);
  const visibleAlarms = Object.values(alarms).filter((alarm) => !dismissed[alarm.nodeId]);

  return (
    <NodeAlarmContext.Provider value={value}>
      <NodeAlarmBanner alarms={visibleAlarms} onDismiss={dismissAlarm} />
      {children}
    </NodeAlarmContext.Provider>
  );
}

export function useNodeAlarms() {
  return useContext(NodeAlarmContext);
}
