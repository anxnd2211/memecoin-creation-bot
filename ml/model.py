"""Launch-decision model: from what is known at the moment of launch, how likely a launch is to draw buyers and what
the playbook's exit would make on it.

Features are only things known before the create transaction: the dev buy, launch tool, links, how old the linked
post is, how many launches the same post and ticker already had, the source account's record before this launch, the
dev's record before this launch, the hour, and the name and description lengths. The model is trained on the earlier
launches and scored on the later ones it never saw (the way it will be used), against simple rule baselines.

Usage: python3 ml/model.py [train share=0.6]  -> report, and data/models/launch_model.pkl for the launch board
"""
import os
import pickle
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr

sys.path.insert(0, 'ml')
from common import load  # noqa: E402

TOOLS = ['j7tracker', 'uxento', 'rapidlaunch', 'ipfs.io', 'other']


def features(df: pd.DataFrame) -> pd.DataFrame:
    """Launch-time features; source-account and dev records use only launches before each one."""
    df = df.sort_values('ts').copy()
    t = df.xLink == 'tweet'
    df['tweetKey'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
    df['priorOnPost'] = df.groupby('tweetKey').cumcount().where(t)
    # The source account's record before this launch (smoothed toward the overall rate).
    h = df.xHandle.where(t)
    prior_n = df.groupby(h).cumcount().where(t)
    prior_hits = (df.groupby(h).active.cumsum() - df.active).where(t)
    base = 0.4
    df['sourceLaunches'] = prior_n
    df['sourceRate'] = (prior_hits + 5 * base) / (prior_n + 5)
    X = pd.DataFrame({
        'devBuy': df.curveBuy,
        'postAgeLog': np.log1p(df.tweetAgeSec.clip(lower=0)).where(t),
        'linkTweet': t.astype(int),
        'linkCommunityOrProfile': df.xLink.isin(['community', 'profile']).astype(int),
        'website': (df.website.fillna('').str.len() > 0).astype(int),
        'telegram': df.telegram.fillna(False).astype(int),
        'priorOnPost': df.priorOnPost,
        'sourceLaunches': df.sourceLaunches,
        'sourceRate': df.sourceRate,
        'waveBefore': df.waveBefore,
        'waveBusyBefore': df.waveBusyBefore,
        'devPriorLaunches': df.devPriorLaunches,
        'devPriorBusyShare': (df.devPriorBusy / df.devPriorLaunches).where(df.devPriorLaunches > 0),
        'hourUtc': df.hourUtc,
        'descriptionLength': df.descriptionLength,
        'nameLength': df.nameLength,
        'symbolLength': df.symbolLength,
        **{f'tool_{k}': (df.tool == k).astype(int) for k in TOOLS},
    }, index=df.index)
    return df, X


def main():
    share = float(sys.argv[1]) if len(sys.argv) > 1 else 0.6
    df = load()
    df = df[df.clearOfGaps & df.metaKnown & (df.tool != 'vercel-blob') & (df.curveBuy >= 0.5)]
    df, X = features(df)
    y = df.active.astype(int).to_numpy()
    pnl = df.pnlV1.to_numpy()
    cut = int(len(df) * share)
    tr, te = np.arange(cut), np.arange(cut, len(df))
    print(f'Launches with a 0.5+ SOL dev buy and fetched metadata: {len(df)}; trained on the first {cut} '
          f'({df.time.iloc[0]:%m-%d %H:%M}-{df.time.iloc[cut - 1]:%H:%M} UTC), scored on the last {len(te)} '
          f'({df.time.iloc[cut]:%H:%M}-{df.time.iloc[-1]:%H:%M}).')

    clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=30,
                                         l2_regularization=1.0, random_state=7)
    clf.fit(X.iloc[tr], y[tr])
    p = clf.predict_proba(X.iloc[te])[:, 1]
    reg = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=30,
                                        l2_regularization=1.0, loss='absolute_error', random_state=7)
    reg.fit(X.iloc[tr], pnl[tr])
    q = reg.predict(X.iloc[te])

    # Baselines: dev buy alone, and the v1 launch rules as a logistic model.
    base_cols = ['devBuy', 'linkTweet', 'website']
    lr = LogisticRegression(max_iter=1000).fit(X.iloc[tr][base_cols].fillna(0), y[tr])
    pb = lr.predict_proba(X.iloc[te][base_cols].fillna(0))[:, 1]
    print('\n== Drew buyers, on launches the model never saw (AUC: 0.5 is a coin toss, 1.0 is perfect)')
    print(f'   dev buy alone {roc_auc_score(y[te], X.iloc[te].devBuy):.3f}; v1 rules (dev buy, post link, website) '
          f'{roc_auc_score(y[te], pb):.3f}; full model {roc_auc_score(y[te], p):.3f}')
    print(f'   result under the v1 exit, rank agreement with the prediction: {spearmanr(q, pnl[te]).statistic:.3f} '
          f'(rules: {spearmanr(pb, pnl[te]).statistic:.3f})')

    print('\n== If we had launched only the launches the model rated best (held-out launches)')
    rows = []
    for name, score in [('model: chance of drawing buyers', p), ('model: expected result', q), ('v1 rules', pb)]:
        order = np.argsort(-score)
        for top in [0.1, 0.25, 0.5, 1.0]:
            k = max(1, int(top * len(te)))
            sel = order[:k]
            rows.append(dict(score=name, top=f'{top:.0%}', launches=k, drew=y[te][sel].mean(), mean=pnl[te][sel].mean(),
                             median=np.median(pnl[te][sel]), profitable=(pnl[te][sel] > 0).mean()))
    print(pd.DataFrame(rows).to_string(index=False, float_format=lambda v: f'{v:.2f}'))

    print('\n== What the model leans on (drop in held-out AUC when the feature is shuffled)')
    imp = permutation_importance(clf, X.iloc[te], y[te], scoring='roc_auc', n_repeats=10, random_state=7)
    order = np.argsort(-imp.importances_mean)
    for i in order[:12]:
        print(f'   {X.columns[i]:24} {imp.importances_mean[i]:+.3f}')

    # Refit on everything for use, and save.
    clf.fit(X, y)
    reg.fit(X, pnl)
    os.makedirs('data/models', exist_ok=True)
    with open('data/models/launch_model.pkl', 'wb') as f:
        pickle.dump({'classifier': clf, 'regressor': reg, 'columns': list(X.columns), 'trained_to': int(df.ts.max())}, f)
    print('\nSaved data/models/launch_model.pkl (refit on all launches).')


if __name__ == '__main__':
    main()
