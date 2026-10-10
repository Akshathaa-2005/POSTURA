import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Shows a calm recovery screen instead of a blank page if rendering throws. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Postura crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/postura-mark.png" alt="" className="h-20 w-auto opacity-80" />
        <h1 className="font-display text-4xl text-slate">Something slipped out of alignment.</h1>
        <p className="max-w-md text-sm font-light text-stone">
          An unexpected error stopped the page. Your camera is off and nothing was lost. Reloading usually fixes it.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 rounded-full bg-forest px-8 py-3 text-sm font-medium text-cream transition hover:bg-[#173a24]"
        >
          Reload
        </button>
        <pre className="mt-4 max-w-full overflow-x-auto text-xs text-stone/70">{this.state.error.message}</pre>
      </div>
    );
  }
}
