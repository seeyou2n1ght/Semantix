"""Controlled candidate-policy contracts; these do not measure relevance accuracy."""
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.ranking.features import FeatureBuilder
from services.ranking.normalizer import ScoreNormalizer
from services.retrieval_service import RetrievalCandidate


def candidate(path, semantic=.2, lexical=0., strength=1.):
    return RetrievalCandidate(
        path, path, path, [1., 0.], semantic, lexical, 0, [], [], path,
        lexical_evidence_strength=strength,
    )


@pytest.mark.parametrize('scores,strengths,expected', [
    ([10., 20., 30.], [1., 1., 1.], [1/3, 2/3, 1.]),
    ([1_000_000., 4., 2.], [.25, 1., 1.], [.25, 1., .5]),
    ([100., 80.], [.5, 1.], [.5, 1.]),
    ([100., 80.], [.25, .5], [.25, .5]),
    ([100., 80.], [.25, .25], [.25, .2]),
    ([0., -10.], [1., .25], [0., 0.]),
    ([100., 4., 0.], [0., 1., 1.], [0., 1., 0.]),
    ([1e9, 4., 2.], [0., .25, .5], [0., .25, .5]),
    ([1e9, 4., 2.], [.25, .5, 1.], [.25, .5, 1.]),
    ([], [], []),
])
def test_informative_scale_is_independent_of_discounted_outliers(scores, strengths, expected):
    actual = ScoreNormalizer.normalize_evidence_lexical(scores, strengths)
    assert [value * strength for value, strength in zip(actual, strengths)] == pytest.approx(expected)
    assert all(0. <= value <= 1. for value in actual)
    if strengths and len(set(strengths)) == 1 and strengths[0] > 0:
        assert actual == ScoreNormalizer.normalize_batch_lexical(scores)


def test_lexical_misalignment_is_visible_and_features_keep_strength_cap():
    with pytest.raises(ValueError, match='must align'):
        ScoreNormalizer.normalize_evidence_lexical([1.], [])
    pool = [candidate('weak', .3, 1e9, .25), candidate('topic', .5, 4.)]
    features = FeatureBuilder.build_features(pool)
    assert [f.lexical_norm for f in features] == [.25, 1.]
