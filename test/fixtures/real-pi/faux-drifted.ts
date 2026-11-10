/**
 * The faux provider as a run's pi may find it unlike its orchestrator did: faux-2 cannot think, and faux-1 and
 * faux-3 are unknown to it.
 */
import { fauxModels } from "./faux.ts";

export default fauxModels([{ id: "faux-2", reasoning: false }]);
