from treeherder.autoclassify.utils import score_matches
from treeherder.model.models import FailureLine


def test_score_matches_empty_return():
    output = list(score_matches(matches=[]))
    assert output == []

    output = list(score_matches(matches=FailureLine.objects.none()))
    assert output == []
