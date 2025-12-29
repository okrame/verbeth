// @ts-ignore
import { ethers } from "hardhat";
import { expect } from "chai";
import { SessionModule, MockSafe } from "../typechain-types";
import { Signer } from "ethers";

describe("SessionModule", () => {
  let sessionModule: SessionModule;
  let mockSafe: MockSafe;
  let owner: Signer;
  let sessionSigner: Signer;
  let attacker: Signer;
  let targetContract: Signer; 

  const NO_EXPIRY = ethers.MaxUint256;

  beforeEach(async () => {
    [owner, sessionSigner, attacker, targetContract] = await ethers.getSigners();

    const SessionModuleFactory = await ethers.getContractFactory("SessionModule");
    sessionModule = (await SessionModuleFactory.deploy()) as SessionModule;
    await sessionModule.waitForDeployment();

    const MockSafeFactory = await ethers.getContractFactory("MockSafe");
    mockSafe = (await MockSafeFactory.deploy(await owner.getAddress())) as MockSafe;
    await mockSafe.waitForDeployment();

    await mockSafe.enableModule(await sessionModule.getAddress());
  });

  describe("Session Management", () => {
    it("owner can set session signer", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();

      await expect(sessionModule.connect(owner).setSession(safeAddr, signerAddr, NO_EXPIRY))
      // @ts-ignore
        .to.emit(sessionModule, "SessionSignerSet")
        .withArgs(safeAddr, signerAddr, NO_EXPIRY);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.true;
    });

    it("non-owner cannot set session signer", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();

      await expect(sessionModule.connect(attacker).setSession(safeAddr, signerAddr, NO_EXPIRY))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "NotOwnerOrSafe");
    });

    it("owner can set allowed target", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();

      await expect(sessionModule.connect(owner).setTarget(safeAddr, targetAddr, true))
      // @ts-ignore
        .to.emit(sessionModule, "TargetSet")
        .withArgs(safeAddr, targetAddr, true);

      expect(await sessionModule.isAllowedTarget(safeAddr, targetAddr)).to.be.true;
    });

    it("non-owner cannot set allowed target", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();

      await expect(sessionModule.connect(attacker).setTarget(safeAddr, targetAddr, true))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "NotOwnerOrSafe");
    });

    it("setupSession sets both session and target in one call", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();
      const targetAddr = await targetContract.getAddress();

      await expect(sessionModule.connect(owner).setupSession(safeAddr, signerAddr, NO_EXPIRY, targetAddr))
      // @ts-ignore
        .to.emit(sessionModule, "SessionSignerSet")
        .withArgs(safeAddr, signerAddr, NO_EXPIRY)
        .and.to.emit(sessionModule, "TargetSet")
        .withArgs(safeAddr, targetAddr, true);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.true;
      expect(await sessionModule.isAllowedTarget(safeAddr, targetAddr)).to.be.true;
    });
  });

  describe("Session Validity", () => {
    it("isValidSession returns false for unset session", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.false;
    });

    it("isValidSession returns true for non-expiring session", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();

      await sessionModule.connect(owner).setSession(safeAddr, signerAddr, NO_EXPIRY);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.true;
    });

    it("isValidSession returns true for future expiry", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600; 

      await sessionModule.connect(owner).setSession(safeAddr, signerAddr, futureExpiry);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.true;
    });

    it("isValidSession returns false for past expiry", async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600; 

      await sessionModule.connect(owner).setSession(safeAddr, signerAddr, pastExpiry);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.false;
    });
  });

  describe("Execution", () => {
    beforeEach(async () => {
      const safeAddr = await mockSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();
      const targetAddr = await targetContract.getAddress();

      await sessionModule.connect(owner).setupSession(safeAddr, signerAddr, NO_EXPIRY, targetAddr);
    });

    it("session signer can execute on allowed target", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();
      const callData = "0x12345678";

      await expect(sessionModule.connect(sessionSigner).execute(safeAddr, targetAddr, 0, callData, 0))
      // @ts-ignore
        .to.emit(sessionModule, "Executed")
        .withArgs(safeAddr, targetAddr, 0, true);
    });

    it("non-session signer cannot execute", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();

      await expect(sessionModule.connect(attacker).execute(safeAddr, targetAddr, 0, "0x", 0))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "SessionExpiredOrInvalid");
    });

    it("session signer cannot execute on disallowed target", async () => {
      const safeAddr = await mockSafe.getAddress();
      const disallowedTarget = await attacker.getAddress();

      await expect(sessionModule.connect(sessionSigner).execute(safeAddr, disallowedTarget, 0, "0x", 0))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "TargetNotAllowed");
    });

    it("execution fails if Safe returns false", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();

      await mockSafe.setExecShouldFail(true);

      await expect(sessionModule.connect(sessionSigner).execute(safeAddr, targetAddr, 0, "0x", 0))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "ExecutionFailed");
    });

    it("expired session cannot execute", async () => {
      const safeAddr = await mockSafe.getAddress();
      const targetAddr = await targetContract.getAddress();
      const expiredSignerAddr = await attacker.getAddress();

      const pastExpiry = Math.floor(Date.now() / 1000) - 1;
      await sessionModule.connect(owner).setSession(safeAddr, expiredSignerAddr, pastExpiry);
      await sessionModule.connect(owner).setTarget(safeAddr, targetAddr, true);

      await expect(sessionModule.connect(attacker).execute(safeAddr, targetAddr, 0, "0x", 0))
      // @ts-ignore
        .to.be.revertedWithCustomError(sessionModule, "SessionExpiredOrInvalid");
    });
  });

  describe("Safe as Caller", () => {
    it("Safe itself can setup session (for delegatecall helper pattern)", async () => {
      // Deploy a new Safe where we can impersonate it
      const MockSafeFactory = await ethers.getContractFactory("MockSafe");
      const newSafe = await MockSafeFactory.deploy(await owner.getAddress());
      await newSafe.waitForDeployment();

      const safeAddr = await newSafe.getAddress();
      const signerAddr = await sessionSigner.getAddress();
      const targetAddr = await targetContract.getAddress();

      // Impersonate the Safe address to call setupSession
      // This simulates the delegatecall pattern from ModuleSetupHelper
      await ethers.provider.send("hardhat_impersonateAccount", [safeAddr]);
      await ethers.provider.send("hardhat_setBalance", [safeAddr, "0x1000000000000000000"]);

      const safeSigner = await ethers.getSigner(safeAddr);

      await expect(sessionModule.connect(safeSigner).setupSession(safeAddr, signerAddr, NO_EXPIRY, targetAddr))
      // @ts-ignore
        .to.emit(sessionModule, "SessionSignerSet");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [safeAddr]);

      expect(await sessionModule.isValidSession(safeAddr, signerAddr)).to.be.true;
      expect(await sessionModule.isAllowedTarget(safeAddr, targetAddr)).to.be.true;
    });
  });
});

describe("ModuleSetupHelper", () => {
  // Note: ModuleSetupHelper is designed to be called via delegatecall during Safe.setup()
  it("contract deploys successfully", async () => {
    const Factory = await ethers.getContractFactory("ModuleSetupHelper");
    const helper = await Factory.deploy();
    await helper.waitForDeployment();

    const address = await helper.getAddress();
    expect(address).to.match(/^0x[0-9a-fA-F]{40}$/);
  });
});