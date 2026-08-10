import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="not-found">
      <span>404</span>
      <h1>Page not found</h1>
      <p>The page you requested does not exist or has moved.</p>
      <Link className="button button-primary" to="/">Back to dashboard</Link>
    </div>
  )
}
