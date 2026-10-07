from dataclasses import replace
import pytest

from config import ranking_config
from services.ranking.features import CandidateFeatures
from services.ranking.related import RelatedRanker
from services.ranking.discover import DiscoverRanker
from services.retrieval_service import RetrievalCandidate


def feature():
    candidate = RetrievalCandidate("a.md", "a", "text", [1., 0.], 0.7, 0., 0, [], [], "")
    return CandidateFeatures(candidate, 0.7, 0.7, 0., False, True, 2,
                             shared_links_count=1, is_cross_folder_shared_tag=True)


def test_folder_and_tag_rewards_follow_configuration(monkeypatch):
    import services.ranking.related as related

    original = feature()
    RelatedRanker.rank([original])
    monkeypatch.setattr(related, "ranking_config", replace(ranking_config,
        RELATED_SAME_FOLDER_BOOST=0., RELATED_TAG_OVERLAP_BOOST=0., RELATED_MAX_TAG_BOOST=0.))
    changed = feature()
    RelatedRanker.rank([changed])
    assert original.relevance_score - changed.relevance_score == pytest.approx(0.04)


def test_discovery_bridge_rewards_follow_configuration(monkeypatch):
    import services.ranking.discover as discover

    original = feature()
    original.relevance_score = 0.7
    DiscoverRanker.rank([original], [])
    monkeypatch.setattr(discover, "ranking_config", replace(ranking_config,
        DISCOVER_BRIDGE_SHARED_LINKS_UNIT=0., DISCOVER_BRIDGE_SHARED_LINKS_MAX=0.,
        DISCOVER_BRIDGE_CROSS_TAG_UNIT=0., DISCOVER_BRIDGE_CROSS_TAG_MAX=0.))
    changed = feature()
    changed.relevance_score = 0.7
    DiscoverRanker.rank([changed], [])
    assert original.discover_score - changed.discover_score == pytest.approx(0.10)
