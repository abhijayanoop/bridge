import { useCallback, useEffect, useState } from "react";

/**
 * The active project's auto-dispatch switch. It is re-read whenever the project changes (so each project shows its own state,
 * and after a reload), and `error` is set when the setting could not be read or saved, so "Off" is never shown by mistake.
 */
export function useAutoDispatch(projectId: string | undefined) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = projectId ? `/api/projects/${projectId}/auto-dispatch` : null;

  useEffect(() => {
    setOn(false);
    setError(null);
    if (!url) return;
    let live = true;
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s) => { if (live) setOn(s.on === true); })
      .catch(() => { if (live) setError("Could not read the auto-dispatch setting."); });
    return () => { live = false; };
  }, [url]);

  const set = useCallback((next: boolean) => {
    if (!url) return;
    setError(null);
    fetch(url, { method: "POST", body: JSON.stringify({ on: next }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s) => setOn(s.on === true))
      .catch(() => setError("Could not change auto-dispatch."));
  }, [url]);

  return { on, error, set };
}
