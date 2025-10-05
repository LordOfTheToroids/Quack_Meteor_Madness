import { Component, type ReactNode } from 'react';

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	message?: string;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false };

	static getDerivedStateFromError(err: unknown): State {
		return { hasError: true, message: err instanceof Error ? err.message : String(err) };
	}

		componentDidCatch(error: unknown, info: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
			console.error('UI ErrorBoundary caught', error, info); // Intentional diagnostic logging
	}

	render() {
		if (this.state.hasError) {
			return (
				<div style={{ padding: '2rem', color: '#f5f7fb', background: '#1d2330' }}>
					<h2>Something went wrong.</h2>
						<p style={{ opacity: 0.8 }}>An unexpected error occurred while rendering this panel.</p>
						{this.state.message && (
							<pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', background: '#111723', padding: '0.75rem', borderRadius: 6 }}>
								{this.state.message}
							</pre>
						)}
						<button
							type="button"
							onClick={() => this.setState({ hasError: false, message: undefined })}
							style={{ marginTop: '1rem', background: '#2a3347', border: '1px solid #3d4961', color: '#fff', padding: '0.5rem 0.9rem', borderRadius: 6, cursor: 'pointer' }}
						>Retry Render</button>
				</div>
			);
		}
		return this.props.children;
	}
}

export default ErrorBoundary;
