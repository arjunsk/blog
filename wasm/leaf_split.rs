// Six bits per key leave room for five keys in a u32.
const KEY_BITS: u32 = 6;
const KEY_MASK: u32 = (1 << KEY_BITS) - 1;

#[unsafe(no_mangle)]
pub extern "C" fn insert_key(packed: u32, count: u32, key: u32) -> u32 {
    if count >= 5 || key == 0 || key > KEY_MASK {
        return packed;
    }

    let mut position = 0;
    while position < count {
        let existing = (packed >> (position * KEY_BITS)) & KEY_MASK;
        if existing == key {
            return packed;
        }
        if existing > key {
            break;
        }
        position += 1;
    }

    let shift = position * KEY_BITS;
    let lower_mask = (1 << shift) - 1;
    (packed & lower_mask) | (key << shift) | ((packed & !lower_mask) << KEY_BITS)
}

#[unsafe(no_mangle)]
pub extern "C" fn left_leaf_len(count: u32, capacity: u32) -> u32 {
    if count > capacity {
        count / 2
    } else {
        count
    }
}
