import { readSnapshot, PRODUCT, type Snapshot, type SnapshotQueueItem } from '@/lib/product'

/** The state colour token for a row. Kept here so the class stays a single lookup. */
const stateVar = (state: string): string => `var(--state-${state}, var(--state-drafted))`

const severityBar = (severity: number): string =>
  '█'.repeat(Math.max(1, Math.min(5, severity))) + '·'.repeat(Math.max(0, 5 - severity))

/** The signature element: a 4px state bar per row, with blocked rows indented onto their gates. */
function RailRow({ item, isHead }: { item: SnapshotQueueItem; isHead: boolean }) {
  return (
    <li
      className="rail-row"
      data-head={isHead ? 'true' : 'false'}
      data-state={item.state}
      style={{ '--bar': stateVar(item.state) } as React.CSSProperties}
    >
      <span aria-hidden="true" />
      <span className="rail-rank">sev {item.severity}</span>
      <span className="rail-id">
        <span className="sev" title={`severity ${item.severity} of 5`}>
          {severityBar(item.severity)}
        </span>
        <span>{item.id}</span>
        <span className="tag" data-tone={item.settled ? 'ok' : undefined}>
          {item.state}
        </span>
        {isHead ? <span className="head-chip">next</span> : null}
      </span>
      <span className="rail-meta">
        <span>{item.kind}</span>
        <span>owed by {item.claimant}</span>
        <span>open weight {item.openWeight}</span>
        {!item.settled ? <span>next state {item.nextState}</span> : <span>settled</span>}
      </span>
      {item.blockedBy.length > 0 ? (
        <ul className="rail-gates">
          {item.blockedBy.map((code) => (
            <li className="rail-gate" key={code}>
              {code}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function Verdict({ snapshot }: { snapshot: Snapshot }) {
  const { review } = snapshot
  return (
    <dl className="verdict">
      <div>
        <dt>phase</dt>
        <dd>{review.phase}</dd>
      </div>
      <div>
        <dt>sign-off</dt>
        <dd>{review.caseRatifiable ? 'yes' : 'no'}</dd>
      </div>
      <div>
        <dt>residual exposure</dt>
        <dd>
          {review.residualExposure}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-subtle)' }}>/100</span>
        </dd>
      </div>
      <div>
        <dt>settled</dt>
        <dd>
          {review.settled}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-subtle)' }}>/{review.total}</span>
        </dd>
      </div>
    </dl>
  )
}

function Liability({ snapshot }: { snapshot: Snapshot }) {
  const { liability } = snapshot
  if (liability.shares.length === 0) {
    return (
      <p className="state" data-kind="empty">
        Nothing outstanding — every obligation in this case is settled, so no party is carrying residual
        exposure.
      </p>
    )
  }
  const tones = ['var(--accent)', 'var(--warn)', 'var(--info)', 'var(--state-arbitrated)']
  return (
    <div>
      <div className="stack" aria-hidden="true">
        {liability.shares.map((share, index) => (
          <span
            key={share.party}
            style={{ width: `${(share.share * 100).toFixed(3)}%`, background: tones[index % tones.length] }}
          />
        ))}
      </div>
      <ul style={{ margin: 'var(--space-3) 0 0', padding: 0 }}>
        {liability.shares.map((share) => (
          <li className="share-row" key={share.party}>
            <span>{share.party}</span>
            <span>{(share.share * 100).toFixed(2)}%</span>
            <span style={{ color: 'var(--fg-subtle)' }}>
              {share.micro.toLocaleString('en-US')} of {liability.apportionmentUnit.toLocaleString('en-US')}{' '}
              micro
            </span>
          </li>
        ))}
      </ul>
      <p className="prose" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-3)' }}>
        Shares are apportioned in integer micro-units by largest remainder, so they sum to exactly{' '}
        {liability.apportionmentUnit.toLocaleString('en-US')} — conservation is an exact fact, not a rounding
        tolerance.
      </p>
    </div>
  )
}

function Trail({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.attempts.length === 0) {
    return (
      <p className="state" data-kind="empty">
        No adjudication attempts recorded yet.
      </p>
    )
  }
  return (
    <ul className="trail">
      {snapshot.attempts.slice(0, 12).map((attempt, index) => (
        <li key={`${attempt.obligationId}-${attempt.at}-${index}`}>
          <span data-tone={attempt.allowed ? 'ok' : 'danger'} className="tag">
            {attempt.allowed ? 'applied' : 'refused'}
          </span>
          <span>
            {attempt.obligationId}: {attempt.fromState} → {attempt.toState}
            {attempt.actor ? ` by ${attempt.actor}` : ''}
          </span>
          <span style={{ color: 'var(--fg-subtle)' }}>{attempt.code}</span>
        </li>
      ))}
    </ul>
  )
}

export default function ReviewPage() {
  const snapshot = readSnapshot()

  return (
    <>
      <section className="hero">
        <span className="eyebrow">
          v{PRODUCT.version} · {snapshot.case.systemName}
        </span>
        <h1>{snapshot.case.title}</h1>
        <p>
          {snapshot.review.total} obligations, one state graph. Nothing here moves unless the engine finds the
          evidence for it — and every refusal below is recorded, because a review you cannot audit is not a
          review.
        </p>
      </section>

      <section aria-labelledby="verdict-heading" style={{ marginBottom: 'var(--space-7)' }}>
        <h2 id="verdict-heading" className="sr-only">
          Case verdict
        </h2>
        <Verdict snapshot={snapshot} />
        <p className="prose" style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
          Next action: <strong>{snapshot.review.nextAction}</strong>
        </p>
      </section>

      <section aria-labelledby="queue-heading" style={{ marginBottom: 'var(--space-7)' }}>
        <h2 id="queue-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          The queue
        </h2>
        {snapshot.queue.count === 0 ? (
          <p className="state" data-kind="empty">
            No obligations recorded in this case yet.
          </p>
        ) : (
          <ol className="rail">
            {snapshot.queue.items.map((item) => (
              <RailRow item={item} isHead={item.id === snapshot.queue.head} key={item.id} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="blocking-heading" style={{ marginBottom: 'var(--space-7)' }}>
        <h2 id="blocking-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          What stands between this case and sign-off
        </h2>
        {snapshot.review.caseBlocking.length === 0 ? (
          <p className="state" data-kind="empty">
            Nothing is blocking sign-off. Every obligation is settled.
          </p>
        ) : (
          <ul className="rail">
            {snapshot.review.caseBlocking.map((gate) => (
              <li className="rail-row" key={`${gate.obligationId}-${gate.code}`} data-state="rejected">
                <span aria-hidden="true" />
                <span className="rail-rank">sev {gate.severity}</span>
                <span className="rail-id">
                  <span>{gate.obligationId}</span>
                  <span className="tag" data-tone="danger">
                    {gate.code}
                  </span>
                </span>
                <span className="rail-meta">
                  <span style={{ color: 'var(--fg-muted)' }}>{gate.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="liability-heading" style={{ marginBottom: 'var(--space-7)' }}>
        <h2 id="liability-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          Who is carrying it
        </h2>
        <Liability snapshot={snapshot} />
      </section>

      <section aria-labelledby="trail-heading" style={{ marginBottom: 'var(--space-7)' }}>
        <h2 id="trail-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          The audit trail
        </h2>
        <Trail snapshot={snapshot} />
      </section>
    </>
  )
}
