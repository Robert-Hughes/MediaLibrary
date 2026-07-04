import React from "react";

type Props = {
  children: React.ReactNode;
  name: string;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const componentStack = info.componentStack ?? "(no component stack)";
    const errorStack = error.stack ?? "(no stack)";
    console.error(
      `[ErrorBoundary:${this.props.name}] ${error.name}: ${error.message}\n` +
        `stack:\n${errorStack}\n` +
        `componentStack:${componentStack}`,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div
        style={{
          padding: 24,
          fontFamily: "sans-serif",
          color: "#eee",
          background: "#222",
          height: "100vh",
          overflow: "auto",
        }}
      >
        <h2 style={{ marginTop: 0 }}>
          Something went wrong in {this.props.name}
        </h2>
        <pre style={{ whiteSpace: "pre-wrap", color: "#f88" }}>
          {error.name}: {error.message}
        </pre>
        {error.stack && (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.75 }}>
            {error.stack}
          </pre>
        )}
        <button onClick={this.reset} style={{ marginTop: 12 }}>
          Retry
        </button>
      </div>
    );
  }
}
