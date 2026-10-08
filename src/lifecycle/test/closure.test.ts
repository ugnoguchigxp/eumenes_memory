import { describe, expect, test } from "bun:test";
import type {
	ClosureEdge,
	ClosureNodeRef,
	DependencyNodeType,
	DependentNodeType,
} from "../../contracts/lifecycle.ts";
import { computeClosure } from "../closure.ts";

function edge(
	dependentType: DependentNodeType,
	dependentId: string,
	dependencyType: DependencyNodeType,
	dependencyId: string,
): ClosureEdge {
	return {
		dependentType,
		dependentId,
		dependencyType,
		dependencyId,
		role: "support",
	};
}

const START: ClosureNodeRef = { type: "source", id: "s0" };

describe("computeClosure", () => {
	test("follows dependency to dependent transitively, including uncited inputs", () => {
		const edges = [
			edge("extraction_run", "run1", "source", "s0"), // 入力として張られた辺（引用されたか否かに依らない）
			edge("candidate", "c1", "extraction_run", "run1"),
			edge("candidate", "c2", "extraction_run", "run1"),
			edge("state_item", "i1", "candidate", "c1"),
			edge("external", "p:e1", "state_item", "i1"),
			edge("state_item", "iX", "source", "other"), // 無関係
		];
		const closure = computeClosure(edges, [START]);
		expect(closure.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
			"candidate:c1",
			"candidate:c2",
			"external:p:e1",
			"extraction_run:run1",
			"state_item:i1",
		]);
		expect(closure.counts).toEqual({
			candidate: 2,
			external: 1,
			extraction_run: 1,
			state_item: 1,
		});
	});

	test("terminates on cycles and never returns the start nodes", () => {
		const edges = [
			edge("candidate", "c1", "extraction_run", "run1"),
			edge("extraction_run", "run1", "candidate", "c1"),
			edge("extraction_run", "run1", "source", "s0"),
		];
		const closure = computeClosure(edges, [START]);
		expect(closure.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
			"candidate:c1",
			"extraction_run:run1",
		]);
	});

	test("result does not depend on edge order (shuffled with a fixed PRNG)", () => {
		let state = 12345;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 4294967296;
		};
		const edges: ClosureEdge[] = [];
		const types: DependentNodeType[] = [
			"state_item",
			"candidate",
			"extraction_run",
		];
		for (let index = 0; index < 60; index += 1) {
			const type = types[Math.floor(random() * 3)] as DependentNodeType;
			const parentType = (
				index % 5 === 0 ? "source" : types[Math.floor(random() * 3)]
			) as DependencyNodeType;
			const parentId =
				parentType === "source" ? "s0" : `n${Math.floor(random() * 20)}`;
			edges.push(
				edge(type, `n${Math.floor(random() * 20)}`, parentType, parentId),
			);
		}
		const expected = computeClosure(edges, [START]);
		for (let round = 0; round < 20; round += 1) {
			const shuffled = [...edges].sort(() => random() - 0.5);
			expect(computeClosure(shuffled, [START])).toEqual(expected);
		}
	});
});
