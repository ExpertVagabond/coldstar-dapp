import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Check, Loader2, Trophy } from 'lucide-react';
import { useNavigate } from 'react-router';
import { BottomNav } from '../shared/BottomNav';
import { PinVerification } from '../shared/PinVerification';
import { getPublicKey } from '../../../services/wallet';
import {
  fetchBoard,
  fetchLeaderboard,
  claimStep,
  type QuestBoard,
  type QuestCampaign,
  type QuestStep,
  type LeaderRow,
} from '../../../services/quests';

/**
 * Quest board. Second front-end over the same coldstar.dev/api/quests that
 * serves the web board — campaigns, points and the completion bonus are all
 * decided server-side, so the two surfaces can never disagree.
 */
export function Quests() {
  const navigate = useNavigate();
  const wallet = getPublicKey();

  const [board, setBoard] = useState<QuestBoard | null>(null);
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, lb] = await Promise.all([fetchBoard(wallet), fetchLeaderboard(wallet)]);
      if (b?.ok) setBoard(b);
      if (lb?.ok) setLeaders(lb.leaders || []);
    } catch {
      setNotice({ text: 'Could not reach the quest board.', bad: true });
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    load();
  }, [load]);

  // PIN is collected by PinVerification, then used once to produce the
  // ownership signature. It is never stored here.
  const onPinVerified = async (pin: string) => {
    const stepId = pinFor;
    setPinFor(null);
    if (!stepId || !wallet) return;

    setBusyStep(stepId);
    setNotice(null);
    try {
      const res = await claimStep(wallet, stepId, pin);
      if (res.ok) {
        let text = res.already ? 'Already claimed.' : `+${(res.awarded || 0).toLocaleString()} pts`;
        if (res.bonusAwarded) text += ` · campaign bonus +${res.bonusAwarded.toLocaleString()} pts`;
        setNotice({ text });
      } else {
        setNotice({ text: res.error || 'Not completed yet.', bad: true });
      }
    } catch {
      setNotice({ text: 'Could not verify — try again.', bad: true });
    } finally {
      setBusyStep(null);
      load();
    }
  };

  const pill = (step: QuestStep) => {
    if (step.done) {
      return (
        <div className="flex-none flex items-center gap-1.5 rounded-xl border border-emerald-400/40 px-3 py-2.5 text-emerald-400/75 text-xs font-mono">
          <Check className="w-3.5 h-3.5" /> DONE
        </div>
      );
    }
    if (busyStep === step.id) {
      return (
        <div className="flex-none flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2.5 text-white/40 text-xs font-mono">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> CHECKING
        </div>
      );
    }
    return (
      <button
        onClick={() => setPinFor(step.id)}
        disabled={!wallet}
        className="flex-none rounded-xl border-[1.5px] border-emerald-400 px-3 py-2.5 text-emerald-400 text-xs font-mono
                   active:bg-emerald-400 active:text-black disabled:border-white/15 disabled:text-white/30 transition-colors"
      >
        +{step.points.toLocaleString()} PTS
      </button>
    );
  };

  const campaign = (c: QuestCampaign) => {
    const [first, ...rest] = c.title.split(' ');
    return (
      <section key={c.id} className="border-t border-white/[0.06] pt-6 pb-2">
        <div className="text-center mb-4">
          <div className="font-semibold tracking-[0.12em] text-sm">
            <span className={c.bonusEarned ? 'text-emerald-400' : 'text-cyan-300'}>{first}</span>
            {rest.length ? ' ' + rest.join(' ') : ''} QUEST
          </div>
          <p className="mt-1.5 text-[11px] font-mono uppercase tracking-wide text-white/45 px-6">
            Earn {c.stepPoints.toLocaleString()} pts
            {c.bonusPoints > 0 && (
              <>
                {' + '}
                <span className="text-emerald-400">{c.bonusPoints.toLocaleString()} bonus pts</span>
                {` for completing all ${c.stepsTotal} step${c.stepsTotal === 1 ? '' : 's'}`}
              </>
            )}
            {c.stepsDone > 0 && ` · ${c.stepsDone}/${c.stepsTotal} done`}
          </p>
        </div>

        <div className="px-1">
          {c.steps.map((s) => (
            <div key={s.id} className="flex items-center gap-3.5 py-3.5 border-b border-white/[0.05] last:border-b-0">
              <div className="flex-none w-11 h-11 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center overflow-hidden text-cyan-300 text-lg">
                {s.iconUrl ? <img src={s.iconUrl} alt="" className="w-full h-full object-cover" /> : s.icon || '◆'}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold tracking-wide ${s.done ? 'text-white/45' : 'text-white'}`}>
                  {s.title}
                </div>
                {s.description && <p className="text-[12px] leading-snug text-white/40 mt-0.5">{s.description}</p>}
              </div>
              {pill(s)}
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col pb-28">
      {/* header */}
      <div className="sticky top-0 z-40 bg-black/95 backdrop-blur-xl border-b border-white/[0.07]">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl bg-white/[0.06] flex items-center justify-center">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold tracking-[0.06em] flex-1">QUESTS</h1>
          <div className="font-mono text-xs border border-white/15 rounded-full px-4 py-2">
            <span className="text-cyan-300 font-semibold">{(board?.points || 0).toLocaleString()}</span> PTS
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto w-full px-4">
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mt-4 rounded-xl px-4 py-3 text-sm ${
              notice.bad ? 'bg-red-500/10 text-red-300 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
            }`}
          >
            {notice.text}
          </motion.div>
        )}

        {!wallet && (
          <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/50">
            Set up a wallet to start earning points.
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-white/40">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : (
          <>
            <p className="text-white/45 text-sm mt-5 mb-5">
              Points for putting $COLD to work and running a real air-gapped wallet. On-chain steps are checked against
              Solana.
            </p>

            {(board?.campaigns || []).map(campaign)}

            {leaders.length > 0 && (
              <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <h2 className="flex items-center gap-2 text-sm font-semibold tracking-[0.1em] mb-3">
                  <Trophy className="w-4 h-4 text-cyan-300" /> LEADERBOARD
                </h2>
                <ol className="font-mono text-xs">
                  {leaders.map((l) => (
                    <li
                      key={l.rank}
                      className={`flex justify-between gap-3 py-1.5 border-b border-white/5 last:border-b-0 ${
                        l.isYou ? 'text-cyan-300' : 'text-white/50'
                      }`}
                    >
                      <span className="w-7 text-white/35">{l.rank}</span>
                      <span className="flex-1">{l.wallet}</span>
                      <span className="text-white">{l.points.toLocaleString()}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <p className="text-[11px] text-white/30 text-center mt-6 leading-relaxed">
              Points record participation. They are not a token, not a claim on one, and carry no promise of future
              value.
            </p>
          </>
        )}
      </div>

      <PinVerification
        isOpen={!!pinFor}
        onClose={() => setPinFor(null)}
        onVerified={onPinVerified}
        title="Verify Quest"
        description="Authorize to prove this wallet is yours. Nothing is spent and no transaction is sent."
      />

      <BottomNav />
    </div>
  );
}
