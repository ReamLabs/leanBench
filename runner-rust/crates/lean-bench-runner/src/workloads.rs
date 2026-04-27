//! Workload implementations. Each returns a Record with samples_ns and a
//! workload-specific metadata blob.

use anyhow::Result;

use crate::{make_record, time_loop, CommonArgs, Record};

pub mod leansig {
    use super::*;
    use ::leansig::serialization::Serializable;
    use ::leansig::signature::generalized_xmss::instantiations_poseidon::lifetime_2_to_the_20::target_sum::SIGTargetSumLifetime20W4NoOff as Scheme;
    use ::leansig::signature::{SignatureScheme, SignatureSchemeSecretKey};
    use ::leansig::MESSAGE_LENGTH;
    // leanSig pins rand 0.9; use the aliased import.
    use rand_09::{rngs::StdRng, Rng, SeedableRng};

    const VARIANT: &str = "SIGTargetSumLifetime20W4NoOff";

    pub fn keygen(args: &CommonArgs) -> Result<Record> {
        // Keygen is the heaviest operation (lifetime 2^20). Warmup = 0; we
        // measure the real cost from sample 0. Callers wanting stability use
        // higher --samples.
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let mut rng = StdRng::seed_from_u64(args.seed ^ i as u64);
            let t = std::time::Instant::now();
            let _ = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "leansig.keygen",
            samples,
            args.warmup,
            serde_json::json!({ "variant": VARIANT, "lifetime_log2": 20 }),
        ))
    }

    pub fn sign(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (_pk, sk) = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
        let prepared = sk.get_prepared_interval();
        // Pick a fixed epoch inside the prepared window to avoid variance
        // from differing epoch positions.
        let epoch = prepared.clone().next().unwrap() as u32;
        let msg: [u8; MESSAGE_LENGTH] = rng.random();

        let samples = time_loop(args, || {
            let _ = Scheme::sign(&sk, epoch, &msg).expect("sign");
        });
        // Capture one signature size for the record.
        let sig = Scheme::sign(&sk, epoch, &msg).expect("sign");
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "leansig.sign",
            samples,
            args.warmup,
            serde_json::json!({
                "variant": VARIANT,
                "lifetime_log2": 20,
                "message_bytes": MESSAGE_LENGTH,
                "signature_bytes": sig_bytes,
            }),
        ))
    }

    pub fn verify(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (pk, sk) = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
        let prepared = sk.get_prepared_interval();
        let epoch = prepared.clone().next().unwrap() as u32;
        let msg: [u8; MESSAGE_LENGTH] = rng.random();
        let sig = Scheme::sign(&sk, epoch, &msg).expect("sign");

        let samples = time_loop(args, || {
            assert!(Scheme::verify(&pk, epoch, &msg, &sig));
        });
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "leansig.verify",
            samples,
            args.warmup,
            serde_json::json!({
                "variant": VARIANT,
                "lifetime_log2": 20,
                "signature_bytes": sig_bytes,
            }),
        ))
    }
}

pub mod xmss_wl {
    use super::*;
    use ::backend::KoalaBear;
    use ::xmss::signers_cache::{message_for_benchmark, BENCHMARK_SLOT};
    use ::xmss::{xmss_key_gen, xmss_sign, xmss_verify, MESSAGE_LEN_FE};
    use rand::{rngs::StdRng, RngExt, SeedableRng};

    pub fn keygen(args: &CommonArgs) -> Result<Record> {
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let mut rng = StdRng::seed_from_u64(args.seed ^ i as u64);
            let seed: [u8; 20] = rng.random();
            let t = std::time::Instant::now();
            let _ = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "xmss.keygen",
            samples,
            args.warmup,
            serde_json::json!({ "slot_range": 1, "log_lifetime": 32 }),
        ))
    }

    pub fn sign(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let seed: [u8; 20] = rng.random();
        let (sk, _pk) = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1).expect("keygen");
        let msg: [KoalaBear; MESSAGE_LEN_FE] = message_for_benchmark();

        let samples = time_loop(args, || {
            let _ = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");
        });
        // One signature for size metadata.
        let sig = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");
        let sig_bytes = postcard::to_allocvec(&sig).unwrap_or_default().len();
        Ok(make_record(
            "xmss.sign",
            samples,
            args.warmup,
            serde_json::json!({ "message_len_fe": MESSAGE_LEN_FE, "signature_bytes": sig_bytes }),
        ))
    }

    pub fn verify(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let seed: [u8; 20] = rng.random();
        let (sk, pk) = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1).expect("keygen");
        let msg: [KoalaBear; MESSAGE_LEN_FE] = message_for_benchmark();
        let sig = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");

        let samples = time_loop(args, || {
            xmss_verify(&pk, &msg, &sig, BENCHMARK_SLOT).expect("verify");
        });
        let sig_bytes = postcard::to_allocvec(&sig).unwrap_or_default().len();
        Ok(make_record(
            "xmss.verify",
            samples,
            args.warmup,
            serde_json::json!({ "signature_bytes": sig_bytes }),
        ))
    }
}

pub mod aggregate {
    use super::*;
    use ::rec_aggregation::{benchmark::run_aggregation_benchmark, AggregationTopology};

    /// One leaf aggregator over `n` raw XMSS signatures at LOG_INV_RATE_PROD=2.
    /// Aggregation internally does heavy one-time setup (DFT twiddles, bytecode,
    /// signer cache). First call amortises it, so the warmup iterations matter
    /// — we count only post-warmup samples.
    fn flat_n_r2(args: &CommonArgs, n: usize) -> Result<Record> {
        let topology = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2 };
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let t = std::time::Instant::now();
            let _ = run_aggregation_benchmark(&topology, 0, false);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            &format!("aggregate.flat_{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({ "raw_xmss": n, "log_inv_rate": 2, "topology": "flat" }),
        ))
    }

    pub fn flat_500_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 500) }
    pub fn flat_1000_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 1000) }

    /// 2-to-1 recursion: root combines two 500-sig leaves. Reports total
    /// wall time including both leaves + the recursion step, at r=2.
    pub fn tree_2x500_r2(args: &CommonArgs) -> Result<Record> {
        let leaf = AggregationTopology { raw_xmss: 500, children: vec![], log_inv_rate: 2 };
        let topology = AggregationTopology {
            raw_xmss: 0,
            children: vec![leaf.clone(), leaf],
            log_inv_rate: 2,
        };
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let t = std::time::Instant::now();
            let _ = run_aggregation_benchmark(&topology, 0, false);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "aggregate.tree_2x500_r2",
            samples,
            args.warmup,
            serde_json::json!({
                "leaf_raw_xmss": 500,
                "fan_in": 2,
                "log_inv_rate": 2,
                "topology": "2-to-1 recursion",
                "note": "total wall time includes both leaves; subtract 2 × aggregate.flat_500_r2 for recursion-only cost",
            }),
        ))
    }
}
