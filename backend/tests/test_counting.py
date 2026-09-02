import pytest

from counting import orientation, segments_intersect


@pytest.mark.parametrize(
    ("point", "expected"),
    [
        ((2, 0), 0),
        ((2, 1), 2),
        ((2, -1), 1),
    ],
)
def test_orientation_relative_to_horizontal_segment(point, expected):
    assert orientation((0, 0), (1, 0), point) == expected


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        (((0, 0), (4, 4)), ((0, 4), (4, 0)), True),
        (((0, 0), (4, 0)), ((2, -2), (2, 2)), True),
        (((0, 0), (1, 0)), ((1, 0), (1, 1)), True),
        (((0, 0), (1, 0)), ((2, -1), (2, 1)), False),
        (((0, 0), (4, 0)), ((2, 0), (6, 0)), False),
    ],
)
def test_segment_intersection_cases(first, second, expected):
    assert segments_intersect(first[0], first[1], second[0], second[1]) is expected

