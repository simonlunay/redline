/** Shown when this browser measures the design fonts differently from the CLI (see font-check). */
export function FontWarning({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="alert font-warning" role="alert">
      <p>
        <strong>This browser measures text differently from the CLI,</strong> so line wraps, and
        with them some text-overflow and label-centered results, may differ from the recorded
        scores. Run <code>npx @simonlunay/redline check</code> for the exact result.
      </p>
      <details>
        <summary>Details</summary>
        <ul>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
