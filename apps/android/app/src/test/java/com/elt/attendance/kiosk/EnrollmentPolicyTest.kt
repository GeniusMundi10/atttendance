// PURPOSE: Verify self-service enrollment accepts six-digit codes as strings without losing leading zeroes.
package com.elt.attendance.kiosk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EnrollmentPolicyTest {
    @Test
    fun acceptsSixDigitsIncludingLeadingZeroes() {
        assertTrue(EnrollmentPolicy.validCode("005194"))
        assertTrue(EnrollmentPolicy.validCode("000000"))
    }

    @Test
    fun rejectsWrongLengthsAndNonAsciiDigits() {
        assertFalse(EnrollmentPolicy.validCode("05194"))
        assertFalse(EnrollmentPolicy.validCode("0005194"))
        assertFalse(EnrollmentPolicy.validCode("12a456"))
        assertFalse(EnrollmentPolicy.validCode("１２３４５６"))
        assertFalse(EnrollmentPolicy.validCode(" 12345"))
    }
}
