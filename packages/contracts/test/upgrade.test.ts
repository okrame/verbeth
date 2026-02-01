import { expect } from "chai";
// @ts-ignore
import { ethers, upgrades, network } from "hardhat";
import { VerbethV1 } from "../typechain-types";

const TWO_DAYS = 2 * 24 * 60 * 60; 

describe("VerbethV1 – Upgradeability (UUPS)", function () {
  let verbEth: VerbethV1;
  let owner: any;
  let attacker: any;

  beforeEach(async () => {
    [owner, attacker] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("VerbethV1");
    verbEth = (await upgrades.deployProxy(Factory, [], {
      kind: "uups",
      initializer: "initialize",
    })) as unknown as VerbethV1;
  });

  async function advanceTime(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  it("is initialized correctly", async () => {
    expect(await verbEth.owner()).to.equal(await owner.getAddress());
  });

  it("prevents re‑initialization", async () => {
    await expect(
      verbEth.initialize()
      // @ts-ignore
    ).to.be.revertedWithCustomError(verbEth, "InvalidInitialization");
  });

  it("storage gap is preserved after upgrade", async () => {
    const ImplV2 = await ethers.getContractFactory("VerbethV1");
    const newImpl = await ImplV2.deploy();

    // Propose and wait for timelock
    await verbEth.proposeUpgrade(await newImpl.getAddress());
    await advanceTime(TWO_DAYS);

    // Perform upgrade via UUPS entry point
    await (verbEth as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

    // Ensure it's still functional
    const msg = ethers.encodeBytes32String("hi");
    const topic = ethers.keccak256(ethers.toUtf8Bytes("chat:dev"));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 1;

    await expect(
      verbEth.sendMessage(msg, topic, timestamp, nonce)
      // @ts-ignore
    ).to.emit(verbEth, "MessageSent");
  });

  describe("Upgrade Timelock", function () {
    let newImpl: any;

    beforeEach(async () => {
      const NewImplFactory = await ethers.getContractFactory("VerbethV1");
      newImpl = await NewImplFactory.deploy();
    });

    it("UPGRADE_DELAY is 2 days", async () => {
      expect(await verbEth.UPGRADE_DELAY()).to.equal(TWO_DAYS);
    });

    it("proposeUpgrade sets pending implementation and eligibleAt", async () => {
      const implAddress = await newImpl.getAddress();
      const tx = await verbEth.proposeUpgrade(implAddress);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await verbEth.pendingImplementation()).to.equal(implAddress);
      expect(await verbEth.upgradeEligibleAt()).to.equal(
        block!.timestamp + TWO_DAYS
      );
    });

    it("proposeUpgrade emits UpgradeProposed event", async () => {
      const implAddress = await newImpl.getAddress();
      await expect(verbEth.proposeUpgrade(implAddress))
        // @ts-ignore
        .to.emit(verbEth, "UpgradeProposed")
        .withArgs(implAddress, (value: any) => value > 0);
    });

    it("proposeUpgrade reverts for zero address", async () => {
      await expect(
        verbEth.proposeUpgrade(ethers.ZeroAddress)
        // @ts-ignore
      ).to.be.revertedWith("Invalid implementation");
    });

    it("only owner can propose upgrade", async () => {
      await expect(
        verbEth.connect(attacker).proposeUpgrade(await newImpl.getAddress())
        // @ts-ignore
      ).to.be.revertedWithCustomError(verbEth, "OwnableUnauthorizedAccount");
    });

    it("cancelUpgrade clears pending implementation", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);

      await expect(verbEth.cancelUpgrade())
        // @ts-ignore
        .to.emit(verbEth, "UpgradeCancelled")
        .withArgs(implAddress);

      expect(await verbEth.pendingImplementation()).to.equal(ethers.ZeroAddress);
      expect(await verbEth.upgradeEligibleAt()).to.equal(0);
    });

    it("cancelUpgrade reverts when no pending upgrade", async () => {
      // @ts-ignore
      await expect(verbEth.cancelUpgrade()).to.be.revertedWith(
        "No pending upgrade"
      );
    });

    it("only owner can cancel upgrade", async () => {
      await verbEth.proposeUpgrade(await newImpl.getAddress());

      await expect(
        verbEth.connect(attacker).cancelUpgrade()
        // @ts-ignore
      ).to.be.revertedWithCustomError(verbEth, "OwnableUnauthorizedAccount");
    });

    it("upgrade reverts before timelock expires", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);

      await expect(
        (verbEth as any).upgradeToAndCall(implAddress, "0x")
        // @ts-ignore
      ).to.be.revertedWith("Timelock not expired");

      // Advance time but not enough
      await advanceTime(TWO_DAYS - 100);

      await expect(
        (verbEth as any).upgradeToAndCall(implAddress, "0x")
        // @ts-ignore
      ).to.be.revertedWith("Timelock not expired");
    });

    it("upgrade reverts for non-proposed implementation", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);
      await advanceTime(TWO_DAYS);

      const OtherImplFactory = await ethers.getContractFactory("VerbethV1");
      const otherImpl = await OtherImplFactory.deploy();

      await expect(
        (verbEth as any).upgradeToAndCall(await otherImpl.getAddress(), "0x")
        // @ts-ignore
      ).to.be.revertedWith("Not proposed implementation");
    });

    it("upgrade reverts when no upgrade is proposed", async () => {
      await expect(
        (verbEth as any).upgradeToAndCall(await newImpl.getAddress(), "0x")
        // @ts-ignore
      ).to.be.revertedWith("Not proposed implementation");
    });

    it("upgrade succeeds after timelock expires", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);

      // Advance time past the timelock
      await advanceTime(TWO_DAYS + 1);

      await expect(
        (verbEth as any).upgradeToAndCall(implAddress, "0x")
        // @ts-ignore
      ).to.not.be.reverted;

      // Verify pending state is cleared
      expect(await verbEth.pendingImplementation()).to.equal(ethers.ZeroAddress);
      expect(await verbEth.upgradeEligibleAt()).to.equal(0);
    });

    it("only owner can perform upgrade", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);
      await advanceTime(TWO_DAYS);

      await expect(
        (verbEth as any).connect(attacker).upgradeToAndCall(implAddress, "0x")
        // @ts-ignore
      ).to.be.revertedWithCustomError(verbEth, "OwnableUnauthorizedAccount");
    });

    it("can propose new upgrade after cancellation", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);
      await verbEth.cancelUpgrade();

      // Propose again
      await expect(verbEth.proposeUpgrade(implAddress))
        // @ts-ignore
        .to.emit(verbEth, "UpgradeProposed");

      expect(await verbEth.pendingImplementation()).to.equal(implAddress);
    });

    it("can propose new upgrade replacing previous proposal", async () => {
      const implAddress = await newImpl.getAddress();
      await verbEth.proposeUpgrade(implAddress);

      // Deploy another implementation
      const OtherImplFactory = await ethers.getContractFactory("VerbethV1");
      const otherImpl = await OtherImplFactory.deploy();
      const otherAddress = await otherImpl.getAddress();

      // Propose the new one (replaces the previous)
      await verbEth.proposeUpgrade(otherAddress);

      expect(await verbEth.pendingImplementation()).to.equal(otherAddress);

      // Old implementation should not work even after timelock
      await advanceTime(TWO_DAYS);
      await expect(
        (verbEth as any).upgradeToAndCall(implAddress, "0x")
        // @ts-ignore
      ).to.be.revertedWith("Not proposed implementation");

      // New implementation should work
      await expect(
        (verbEth as any).upgradeToAndCall(otherAddress, "0x")
        // @ts-ignore
      ).to.not.be.reverted;
    });
  });
});
