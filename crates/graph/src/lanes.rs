//! Lane assignment for the commit graph: a pure function of the commits in log order, so a page can resume from the
//! state the previous page left behind.

use serde::{Deserialize, Serialize};

use crate::types::{LaneEdge, LaneEdgeKind};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Slot {
    /// The commit this lane is waiting for (a parent of something already placed).
    oid: String,
    color: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Lanes {
    slots: Vec<Option<Slot>>,
    next_color: u32,
}

#[derive(Debug, PartialEq)]
pub struct Placement {
    pub lane: u32,
    pub color: u32,
    pub edges: Vec<LaneEdge>,
    pub width: u32,
}

impl Lanes {
    fn new_color(&mut self) -> u32 {
        self.next_color += 1;
        self.next_color - 1
    }

    fn free_slot(&mut self) -> usize {
        match self.slots.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                self.slots.push(None);
                self.slots.len() - 1
            }
        }
    }

    /// Places the next commit of the log (children always come before their parents).
    pub fn place(&mut self, oid: &str, parents: &[String]) -> Placement {
        let waiting: Vec<usize> =
            self.slots.iter().enumerate().filter(|(_, s)| s.as_ref().is_some_and(|s| s.oid == oid)).map(|(i, _)| i).collect();
        let mut edges = Vec::new();
        let (node, color) = match waiting.first() {
            Some(&i) => {
                let color = self.slots[i].as_ref().map_or(0, |s| s.color);
                for &w in &waiting {
                    let c = self.slots[w].as_ref().map_or(0, |s| s.color);
                    edges.push(LaneEdge { from: w as u32, to: i as u32, color: c, kind: LaneEdgeKind::Up });
                    if w != i {
                        self.slots[w] = None;
                    }
                }
                (i, color)
            }
            None => {
                let i = self.free_slot();
                (i, self.new_color())
            }
        };
        self.slots[node] = None;
        for (i, slot) in self.slots.iter().enumerate() {
            if let Some(s) = slot {
                edges.push(LaneEdge { from: i as u32, to: i as u32, color: s.color, kind: LaneEdgeKind::Through });
            }
        }
        for (k, parent) in parents.iter().enumerate() {
            let existing = self.slots.iter().position(|s| s.as_ref().is_some_and(|s| &s.oid == parent));
            let (to, edge_color) = match existing {
                Some(j) => (j, self.slots[j].as_ref().map_or(color, |s| s.color)),
                None if k == 0 => {
                    self.slots[node] = Some(Slot { oid: parent.clone(), color });
                    (node, color)
                }
                None => {
                    let j = self.free_slot();
                    let c = self.new_color();
                    self.slots[j] = Some(Slot { oid: parent.clone(), color: c });
                    (j, c)
                }
            };
            edges.push(LaneEdge { from: node as u32, to: to as u32, color: edge_color, kind: LaneEdgeKind::Down });
        }
        while self.slots.last().is_some_and(Option::is_none) {
            self.slots.pop();
        }
        let width = edges.iter().flat_map(|e| [e.from, e.to]).chain([node as u32]).max().unwrap_or(0) + 1;
        Placement { lane: node as u32, color, edges, width }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(o: &str) -> String {
        o.to_owned()
    }

    fn kinds(pl: &Placement, kind: LaneEdgeKind) -> Vec<(u32, u32)> {
        pl.edges.iter().filter(|e| e.kind == kind).map(|e| (e.from, e.to)).collect()
    }

    #[test]
    fn a_linear_history_stays_in_lane_zero() {
        let mut l = Lanes::default();
        let a = l.place("c", &[p("b")]);
        let b = l.place("b", &[p("a")]);
        let c = l.place("a", &[]);
        assert_eq!((a.lane, b.lane, c.lane), (0, 0, 0));
        assert_eq!(kinds(&a, LaneEdgeKind::Down), vec![(0, 0)]);
        assert_eq!(kinds(&b, LaneEdgeKind::Up), vec![(0, 0)]);
        assert!(kinds(&c, LaneEdgeKind::Down).is_empty());
        assert_eq!(c.width, 1);
    }

    #[test]
    fn a_merge_opens_a_lane_and_the_fork_point_closes_it() {
        // m merges b into a-line: m(a2, b1); a2 -> a1; b1 -> a1; a1 root
        let mut l = Lanes::default();
        let m = l.place("m", &[p("a2"), p("b1")]);
        assert_eq!(kinds(&m, LaneEdgeKind::Down), vec![(0, 0), (0, 1)]);
        assert_eq!(m.width, 2);
        let a2 = l.place("a2", &[p("a1")]);
        assert_eq!(a2.lane, 0);
        assert_eq!(kinds(&a2, LaneEdgeKind::Through), vec![(1, 1)]);
        let b1 = l.place("b1", &[p("a1")]);
        assert_eq!(b1.lane, 1);
        // b1's parent a1 is already awaited in lane 0: the edge goes there instead of opening a lane
        assert_eq!(kinds(&b1, LaneEdgeKind::Down), vec![(1, 0)]);
        let a1 = l.place("a1", &[]);
        assert_eq!(a1.lane, 0);
        assert_eq!(l, Lanes { slots: vec![], next_color: 2 });
    }

    #[test]
    fn two_children_of_one_parent_merge_into_the_first_lane() {
        let mut l = Lanes::default();
        l.place("t1", &[p("base")]);
        let t2 = l.place("t2", &[p("base")]);
        assert_eq!(t2.lane, 1);
        let base = l.place("base", &[]);
        assert_eq!(base.lane, 0);
        assert_eq!(kinds(&base, LaneEdgeKind::Up), vec![(0, 0)]);
    }

    #[test]
    fn separate_tips_get_separate_lanes_and_colours() {
        let mut l = Lanes::default();
        let a = l.place("x", &[p("x0")]);
        let b = l.place("y", &[p("y0")]);
        assert_eq!((a.lane, b.lane), (0, 1));
        assert_ne!(a.color, b.color);
    }

    #[test]
    fn an_octopus_merge_opens_one_lane_per_extra_parent() {
        let mut l = Lanes::default();
        let m = l.place("m", &[p("a"), p("b"), p("c")]);
        assert_eq!(kinds(&m, LaneEdgeKind::Down), vec![(0, 0), (0, 1), (0, 2)]);
        assert_eq!(m.width, 3);
    }

    #[test]
    fn the_state_survives_a_round_trip_through_json() {
        let mut l = Lanes::default();
        l.place("m", &[p("a"), p("b")]);
        let again: Lanes = serde_json::from_str(&serde_json::to_string(&l).expect("ser")).expect("de");
        assert_eq!(again, l);
    }
}
