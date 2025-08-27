// ProvenanceRegistry.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ProvenanceEntry {
  timestamp: number;
  updater: string;
  metadata: string;
  location_hash?: string; // buff as string for simplicity
  verified: boolean;
}

interface RegisteredToken {
  registered_at: number;
  owner: string;
}

interface AuthorizedUpdater {
  role: string;
  added_at: number;
}

interface ContractState {
  admin: string;
  paused: boolean;
  total_updates: number;
  provenance_history: Map<string, ProvenanceEntry>; // Key: `${token_id}-${stage}`
  current_stage: Map<number, number>;
  registered_tokens: Map<number, RegisteredToken>;
  authorized_updaters: Map<string, AuthorizedUpdater>; // Key: `${token_id}-${updater}`
  update_count: Map<number, number>;
  farmer_registry_contract: string;
  crop_token_contract: string;
}

// Mock contract implementation
class ProvenanceRegistryMock {
  private state: ContractState = {
    admin: "deployer",
    paused: false,
    total_updates: 0,
    provenance_history: new Map(),
    current_stage: new Map(),
    registered_tokens: new Map(),
    authorized_updaters: new Map(),
    update_count: new Map(),
    farmer_registry_contract: "farmer_registry",
    crop_token_contract: "crop_token",
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_TOKEN_ID = 101;
  private ERR_INVALID_STAGE = 102;
  private ERR_PAUSED = 103;
  private ERR_ALREADY_INITIALIZED = 104;
  private ERR_METADATA_TOO_LONG = 105;
  private ERR_INVALID_UPDATER = 106;
  private ERR_STAGE_OUT_OF_ORDER = 107;
  private ERR_TOKEN_NOT_REGISTERED = 108;
  private ERR_ALREADY_AT_FINAL_STAGE = 109;
  private ERR_INVALID_LOCATION = 110;
  private ERR_UPDATER_ALREADY_REGISTERED = 111;
  private ERR_NOT_FOUND = 112;
  private ERR_INVALID_PARAM = 113;

  private MAX_METADATA_LEN = 1000;
  private MAX_LOCATION_LEN = 64;
  private STAGE_PLANTING = 0;
  private STAGE_GROWING = 1;
  private STAGE_HARVESTING = 2;
  private STAGE_PROCESSING = 3;
  private STAGE_SHIPPING = 4;
  private STAGE_SALE = 5;
  private MAX_STAGE = 5;

  // Mocked trait calls (simplified)
  private mockIsVerifiedFarmer(updater: string): boolean {
    return updater.startsWith("farmer_"); // Assume verified if prefix matches
  }

  private mockGetOwner(token_id: number): string {
    const token = this.state.registered_tokens.get(token_id);
    return token ? token.owner : "";
  }

  private makeHistoryKey(token_id: number, stage: number): string {
    return `${token_id}-${stage}`;
  }

  private makeUpdaterKey(token_id: number, updater: string): string {
    return `${token_id}-${updater}`;
  }

  private validateStageOrder(token_id: number, new_stage: number): boolean {
    const curr = this.state.current_stage.get(token_id) ?? 0;
    return new_stage <= this.MAX_STAGE && new_stage > curr;
  }

  private checkAuthorized(token_id: number, caller: string): boolean {
    const owner = this.mockGetOwner(token_id);
    return caller === owner || this.state.authorized_updaters.has(this.makeUpdaterKey(token_id, caller));
  }

  setFarmerRegistry(caller: string, new_registry: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.farmer_registry_contract = new_registry;
    return { ok: true, value: true };
  }

  setCropToken(caller: string, new_token_contract: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.crop_token_contract = new_token_contract;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  transferAdmin(caller: string, new_admin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.admin = new_admin;
    return { ok: true, value: true };
  }

  registerToken(caller: string, token_id: number): ClarityResponse<boolean> {
    const owner = this.mockGetOwner(token_id); // In real, from trait
    if (this.state.registered_tokens.has(token_id)) {
      return { ok: false, value: this.ERR_ALREADY_INITIALIZED };
    }
    this.state.registered_tokens.set(token_id, { registered_at: Date.now(), owner: caller }); // Assume caller is owner for mock
    this.state.current_stage.set(token_id, 0);
    this.state.update_count.set(token_id, 0);
    return { ok: true, value: true };
  }

  addProvenanceEntry(
    caller: string,
    token_id: number,
    stage: number,
    metadata: string,
    location_hash?: string
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (!this.mockIsVerifiedFarmer(caller)) {
      return { ok: false, value: this.ERR_INVALID_UPDATER };
    }
    if (!this.state.registered_tokens.has(token_id)) {
      return { ok: false, value: this.ERR_TOKEN_NOT_REGISTERED };
    }
    if (!this.checkAuthorized(token_id, caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (!this.validateStageOrder(token_id, stage)) {
      return { ok: false, value: this.ERR_STAGE_OUT_OF_ORDER };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_METADATA_TOO_LONG };
    }
    if (location_hash && location_hash.length > this.MAX_LOCATION_LEN) {
      return { ok: false, value: this.ERR_INVALID_LOCATION };
    }
    const key = this.makeHistoryKey(token_id, stage);
    this.state.provenance_history.set(key, {
      timestamp: Date.now(),
      updater: caller,
      metadata,
      location_hash,
      verified: false,
    });
    this.state.current_stage.set(token_id, stage);
    const new_count = (this.state.update_count.get(token_id) ?? 0) + 1;
    this.state.update_count.set(token_id, new_count);
    this.state.total_updates += 1;
    return { ok: true, value: true };
  }

  verifyEntry(caller: string, token_id: number, stage: number): ClarityResponse<boolean> {
    const key = this.makeHistoryKey(token_id, stage);
    const entry = this.state.provenance_history.get(key);
    if (!entry) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    entry.verified = true;
    this.state.provenance_history.set(key, entry);
    return { ok: true, value: true };
  }

  addAuthorizedUpdater(caller: string, token_id: number, updater: string, role: string): ClarityResponse<boolean> {
    const token = this.state.registered_tokens.get(token_id);
    if (!token || caller !== token.owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const key = this.makeUpdaterKey(token_id, updater);
    if (this.state.authorized_updaters.has(key)) {
      return { ok: false, value: this.ERR_UPDATER_ALREADY_REGISTERED };
    }
    this.state.authorized_updaters.set(key, { role, added_at: Date.now() });
    return { ok: true, value: true };
  }

  removeAuthorizedUpdater(caller: string, token_id: number, updater: string): ClarityResponse<boolean> {
    const token = this.state.registered_tokens.get(token_id);
    if (!token || caller !== token.owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const key = this.makeUpdaterKey(token_id, updater);
    this.state.authorized_updaters.delete(key);
    return { ok: true, value: true };
  }

  getCurrentStage(token_id: number): ClarityResponse<number> {
    return { ok: true, value: this.state.current_stage.get(token_id) ?? 0 };
  }

  getProvenanceEntry(token_id: number, stage: number): ClarityResponse<ProvenanceEntry | null> {
    const key = this.makeHistoryKey(token_id, stage);
    return { ok: true, value: this.state.provenance_history.get(key) ?? null };
  }

  getFullHistory(token_id: number): ClarityResponse<ProvenanceEntry[]> {
    const history: ProvenanceEntry[] = [];
    for (let stage = 0; stage <= this.MAX_STAGE; stage++) {
      const key = this.makeHistoryKey(token_id, stage);
      const entry = this.state.provenance_history.get(key);
      if (entry) history.push(entry);
    }
    return { ok: true, value: history };
  }

  isRegisteredToken(token_id: number): ClarityResponse<boolean> {
    return { ok: true, value: this.state.registered_tokens.has(token_id) };
  }

  getAuthorizedUpdaters(token_id: number, updater: string): ClarityResponse<AuthorizedUpdater | null> {
    const key = this.makeUpdaterKey(token_id, updater);
    return { ok: true, value: this.state.authorized_updaters.get(key) ?? null };
  }

  getTotalUpdates(): ClarityResponse<number> {
    return { ok: true, value: this.state.total_updates };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  farmer1: "farmer_1",
  farmer2: "farmer_2",
  unauthorized: "user_1",
};

describe("ProvenanceRegistry Contract", () => {
  let contract: ProvenanceRegistryMock;

  beforeEach(() => {
    contract = new ProvenanceRegistryMock();
    vi.resetAllMocks();
  });

  it("should allow admin to pause and unpause the contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-admin from pausing", () => {
    const pauseResult = contract.pauseContract(accounts.unauthorized);
    expect(pauseResult).toEqual({ ok: false, value: 100 });
  });

  it("should register a new token", () => {
    const registerResult = contract.registerToken(accounts.farmer1, 1);
    expect(registerResult).toEqual({ ok: true, value: true });
    expect(contract.isRegisteredToken(1)).toEqual({ ok: true, value: true });
    expect(contract.getCurrentStage(1)).toEqual({ ok: true, value: 0 });
  });

  it("should prevent duplicate token registration", () => {
    contract.registerToken(accounts.farmer1, 1);
    const duplicateResult = contract.registerToken(accounts.farmer1, 1);
    expect(duplicateResult).toEqual({ ok: false, value: 104 });
  });

  it("should add provenance entry for valid updater and stage", () => {
    contract.registerToken(accounts.farmer1, 1);
    const addResult = contract.addProvenanceEntry(
      accounts.farmer1,
      1,
      1, // STAGE_GROWING
      "Crop growing well",
      "hashed_location"
    );
    expect(addResult).toEqual({ ok: true, value: true });
    expect(contract.getCurrentStage(1)).toEqual({ ok: true, value: 1 });
    const entry = contract.getProvenanceEntry(1, 1);
    expect(entry).toEqual({
      ok: true,
      value: expect.objectContaining({
        updater: accounts.farmer1,
        metadata: "Crop growing well",
        location_hash: "hashed_location",
        verified: false,
      }),
    });
    expect(contract.getTotalUpdates()).toEqual({ ok: true, value: 1 });
  });

  it("should prevent adding entry when paused", () => {
    contract.registerToken(accounts.farmer1, 1);
    contract.pauseContract(accounts.deployer);
    const addResult = contract.addProvenanceEntry(
      accounts.farmer1,
      1,
      1,
      "Crop growing",
    );
    expect(addResult).toEqual({ ok: false, value: 103 });
  });

  it("should prevent unauthorized updater from adding entry", () => {
    contract.registerToken(accounts.farmer1, 1);
    const addResult = contract.addProvenanceEntry(
      accounts.unauthorized,
      1,
      1,
      "Unauthorized update",
    );
    expect(addResult).toEqual({ ok: false, value: 106 });
  });

  it("should prevent metadata exceeding max length", () => {
    contract.registerToken(accounts.farmer1, 1);
    const longMetadata = "a".repeat(1001);
    const addResult = contract.addProvenanceEntry(
      accounts.farmer1,
      1,
      1,
      longMetadata,
    );
    expect(addResult).toEqual({ ok: false, value: 105 });
  });

  it("should allow admin to verify an entry", () => {
    contract.registerToken(accounts.farmer1, 1);
    contract.addProvenanceEntry(accounts.farmer1, 1, 1, "To verify");
    const verifyResult = contract.verifyEntry(accounts.deployer, 1, 1);
    expect(verifyResult).toEqual({ ok: true, value: true });
    const entry = contract.getProvenanceEntry(1, 1);
    expect(entry.value?.verified).toBe(true);
  });

  it("should prevent non-admin from verifying entry", () => {
    contract.registerToken(accounts.farmer1, 1);
    contract.addProvenanceEntry(accounts.farmer1, 1, 1, "To verify");
    const verifyResult = contract.verifyEntry(accounts.unauthorized, 1, 1);
    expect(verifyResult).toEqual({ ok: false, value: 100 });
  });

  it("should add and remove authorized updater", () => {
    contract.registerToken(accounts.farmer1, 1);
    const addUpdaterResult = contract.addAuthorizedUpdater(
      accounts.farmer1,
      1,
      accounts.farmer2,
      "logistics"
    );
    expect(addUpdaterResult).toEqual({ ok: true, value: true });
    const updater = contract.getAuthorizedUpdaters(1, accounts.farmer2);
    expect(updater).toEqual({
      ok: true,
      value: expect.objectContaining({ role: "logistics" }),
    });

    // Now farmer2 can update
    const addEntryByUpdater = contract.addProvenanceEntry(
      accounts.farmer2,
      1,
      1,
      "Update by authorized",
    );
    expect(addEntryByUpdater).toEqual({ ok: true, value: true });

    const removeResult = contract.removeAuthorizedUpdater(accounts.farmer1, 1, accounts.farmer2);
    expect(removeResult).toEqual({ ok: true, value: true });
    expect(contract.getAuthorizedUpdaters(1, accounts.farmer2)).toEqual({ ok: true, value: null });
  });

  it("should prevent non-owner from adding updater", () => {
    contract.registerToken(accounts.farmer1, 1);
    const addUpdaterResult = contract.addAuthorizedUpdater(
      accounts.unauthorized,
      1,
      accounts.farmer2,
      "logistics"
    );
    expect(addUpdaterResult).toEqual({ ok: false, value: 100 });
  });

  it("should return full history", () => {
    contract.registerToken(accounts.farmer1, 1);
    contract.addProvenanceEntry(accounts.farmer1, 1, 1, "Stage 1");
    contract.addProvenanceEntry(accounts.farmer1, 1, 2, "Stage 2");
    const history = contract.getFullHistory(1);
    expect(history.value).toHaveLength(2);
    expect(history.value?.[0].metadata).toBe("Stage 1");
    expect(history.value?.[1].metadata).toBe("Stage 2");
  });
});