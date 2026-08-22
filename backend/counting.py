def orientation(a: tuple[int, int], b: tuple[int, int], c: tuple[int, int]) -> int:
    value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])
    return 0 if value == 0 else (1 if value > 0 else 2)

def segments_intersect(p1: tuple[int, int], q1: tuple[int, int], p2: tuple[int, int], q2: tuple[int, int]) -> bool:
    return orientation(p1, q1, p2) != orientation(p1, q1, q2) and orientation(p2, q2, p1) != orientation(p2, q2, q1)
