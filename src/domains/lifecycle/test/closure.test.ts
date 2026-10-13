import { describe, expect, test } from "bun:test";
import type {
	ClosureEdge,
	ClosureNodeRef,
	DependencyNodeType,
	DependentNodeType,
} from "../contracts/index.ts";
import { computeClosure } from "../service/closure.ts";

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
	test("follows dependency to dependent transitively", () => {
		const edges = [
			edge("state_item", "i1", "source", "s0"),
			edge("state_item", "i2", "state_item", "i1"),
			edge("external", "p:e1", "state_item", "i2"),
			edge("state_item", "iX", "source", "other"), // 無関係
		];
		const closure = computeClosure(edges, [START]);
		expect(closure.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
			"external:p:e1",
			"state_item:i1",
			"state_item:i2",
		]);
		expect(closure.counts).toEqual({ external: 1, state_item: 2 });
	});

	test("terminates on cycles and never returns the start nodes", () => {
		const edges = [
			edge("state_item", "i1", "state_item", "i2"),
			edge("state_item", "i2", "state_item", "i1"),
			edge("state_item", "i1", "source", "s0"),
		];
		const closure = computeClosure(edges, [START]);
		expect(closure.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
			"state_item:i1",
			"state_item:i2",
		]);
	});

	test("result does not depend on edge order (shuffled with a fixed PRNG)", () => {
		let state = 12345;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 4294967296;
		};
		const edges: ClosureEdge[] = [];
		const types: DependentNodeType[] = ["state_item", "external"];
		for (let index = 0; index < 60; index += 1) {
			const type = types[Math.floor(random() * 2)] as DependentNodeType;
			const parentType = (
				index % 5 === 0 ? "source" : "state_item"
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
