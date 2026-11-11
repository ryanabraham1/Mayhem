import { Component, type ErrorInfo, type ReactNode } from "react";
import { download, PROJECT_KEY, recoverySnapshot } from "./storage";
export class SuiteErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Mayhem workspace stopped", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="ms-crash-recovery">
        <h1>Reopen your workspace</h1>
        <p>
          Mayhem stopped rendering this view. Your saved project and original
          recordings are retained.
        </p>
        <pre>{this.state.error}</pre>
        <div>
          <button
            onClick={() => {
              const data =
                localStorage.getItem(PROJECT_KEY) ?? recoverySnapshot();
              if (data) download("mayhem-recovery.json", data);
            }}
          >
            Export saved project
          </button>
          <button onClick={() => location.reload()}>Reload Mayhem</button>
        </div>
      </main>
    );
  }
}
